#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";

// Runs every built Worker in workerd through Miniflare and writes the report
// below. Inputs:
// - ULTRAMODERN_WORKSPACE_ROOT: workspace with topology/ and the report
//   (default: the current directory).
// - ULTRAMODERN_WORKERD_ARTIFACT_ROOT: root holding each app's built
//   `<topology path>/.output` (default: the workspace root).
// - ULTRAMODERN_WORKERD_PROOF_FIXTURE: optional JSON runtime data; see
//   validateWorkerdProofFixture for its format.
// - ULTRAMODERN_KEEP_WORKERD=1: keep the Workers serving on their local ports.
const reportRelativePath = ".codex/reports/cloudflare-workerd-ssr/composition-proof.json";
// Mirrors the public website quality gate default for server-rendered HTML.
const defaultSsrHtmlMaxBytes = 250_000;

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
const readJson = (absolutePath) => JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const diagnosticText = (text, limit) => {
  const bytes = Buffer.from(String(text), "utf8");
  return {
    byteLength: bytes.byteLength,
    preview: bytes.subarray(0, limit).toString("utf8"),
    truncated: bytes.byteLength > limit,
  };
};

class ProofLog extends Log {
  errors = [];

  constructor() {
    super(LogLevel.ERROR);
  }

  logWithLevel(level, message) {
    if (level === LogLevel.ERROR) {
      this.errors.push(diagnosticText(message, 4096));
      if (this.errors.length > 8) this.errors.shift();
    }
    super.logWithLevel(level, message);
  }
}

const assertSuccessfulSsrResponse = (
  appId,
  route,
  response,
  html,
  log,
  outboundRequests,
) => {
  if (response.status === 200) return;
  const bytes = Buffer.from(html, "utf8");
  throw new Error(
    `${appId} returned HTTP ${response.status} for ${route} in workerd\n` +
      JSON.stringify({
        appId,
        route,
        status: response.status,
        contentType: response.headers.get("content-type"),
        responseBody: { ...diagnosticText(html, 8192), sha256: sha256(bytes) },
        outboundRequests,
        workerErrors: log.errors,
      }),
  );
};
const count = (source, value) => source.split(value).length - 1;
const normalizePath = (value) => String(value).replace(/\\/gu, "/");
const DISTRIBUTED_SSR_FRAGMENT_REQUEST_HEADER =
  "x-modern-js-fragment-request";
const DISTRIBUTED_SSR_REQUIRED_HEADERS = [
  "x-modern-distributed-ssr-boundary-id",
  "x-modern-distributed-ssr-expose",
  "x-modern-distributed-ssr-props",
  "x-modern-distributed-ssr-remote",
  "x-modern-distributed-ssr-source-url",
];

const collectJavaScriptFiles = (absoluteDirectory) => {
  if (!fs.existsSync(absoluteDirectory)) {
    return [];
  }

  return fs
    .readdirSync(absoluteDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        return collectJavaScriptFiles(absolutePath);
      }
      return entry.isFile() && /\.(?:c|m)?js$/u.test(entry.name) ? [absolutePath] : [];
    })
    .sort();
};

const createWorkerModules = (outputRoot, main) => {
  const entryPath = path.resolve(outputRoot, main);
  const modulePaths = [
    entryPath,
    ...collectJavaScriptFiles(path.join(outputRoot, "server")),
    ...collectJavaScriptFiles(path.join(outputRoot, "worker")),
  ].filter((modulePath, index, paths) => paths.indexOf(modulePath) === index);

  return modulePaths.map((modulePath) => ({
    type: modulePath.endsWith(".cjs") ? "CommonJS" : "ESModule",
    path: modulePath,
  }));
};

const readExecutionEnvelope = async (appId, appRoot, outputRoot, expectedUnitId) => {
  const envelopePath = path.join(
    outputRoot,
    "release/microvertical-release-envelope.json",
  );
  assert(fs.existsSync(envelopePath), `${appId} executed .output release envelope is missing`);
  // The verifier is the workspace app's own toolchain, wherever its built
  // artifacts were placed.
  const appRequire = createRequire(path.join(appRoot, "package.json"));
  const sdkRequire = createRequire(
    appRequire.resolve("@modern-js/ultramodern-app-tools"),
  );
  const {
    MICROVERTICAL_RELEASE_ENVELOPE_SCHEMA_VERSION: schemaVersion,
    verifyMicroVerticalReleaseEnvelope,
  } = sdkRequire(
    "@modern-js/app-tools-extensions/release-envelope",
  );
  assert(schemaVersion === 5, `${appId} executed envelope owner must use schema 5`);
  const envelope = await verifyMicroVerticalReleaseEnvelope(
    readJson(envelopePath),
    { artifactRoot: outputRoot, expectedTarget: "cloudflare" },
  );
  assert(
    typeof expectedUnitId === "string" &&
      expectedUnitId.length > 0 &&
      envelope.identity?.unitId === expectedUnitId,
    `${appId} executed envelope unit identity is invalid`,
  );
  return { envelope, envelopePath };
};

const bindExecutedModule = (app, envelope, module) => {
  const logicalPath = normalizePath(path.relative(app.outputRoot, module.path));
  assert(
    logicalPath.length > 0 &&
      !logicalPath.startsWith("../") &&
      !path.posix.isAbsolute(logicalPath),
    `${app.id} selected module escapes .output: ${logicalPath}`,
  );
  const artifact = envelope.artifacts.find(
    (candidate) => candidate.logicalPath === logicalPath,
  );
  assert(artifact, `${app.id} selected module ${logicalPath} is not envelope-bound`);
  assert(
    artifact.kind === "file",
    `${app.id} selected module ${logicalPath} is bound to a non-file artifact`,
  );
  const bytes = fs.readFileSync(module.path);
  const digest = sha256(bytes);
  assert(
    artifact.byteLength === bytes.byteLength && artifact.sha256 === digest,
    `${app.id} selected module ${logicalPath} differs from its envelope artifact`,
  );
  return {
    byteLength: bytes.byteLength,
    logicalPath,
    runtime: artifact.runtime,
    sha256: digest,
    type: module.type,
  };
};

const normalizeRoutes = (routes) => [
  ...new Set(
    (Array.isArray(routes) ? routes : []).filter(
      (route) => typeof route === "string" && route.startsWith("/"),
    ),
  ),
];

// The generator's distributed SSR contract: every expose except the page
// route is a fragment a host can server-render (see distributedSsrExposes).
const declaresDistributedSsrExpose = (rawApp) =>
  Array.isArray(rawApp?.moduleFederation?.exposes) &&
  rawApp.moduleFederation.exposes.some(
    (expose) => typeof expose === "string" && expose !== "./Route",
  );

/**
 * Derive what the proof must execute from topology/reference-topology.json.
 *
 * - `ssrRoutes`: every route the app itself must server-render on its own
 *   Worker (`cloudflare.routes.ssr` plus `cloudflare.distributedSsrProofRoutes`).
 * - `serverRenderedRoutes`: shell routes that must compose distributed SSR
 *   boundaries. `cloudflare.distributedSsrProofRoutes` declares them; without
 *   it the shell's `cloudflare.routes.ssr` is the composition route. An empty
 *   array declares a shell whose MicroVerticals load on the client only.
 * - `serverRenderedRemoteIds`: shell `verticalRefs` whose topology declares a
 *   distributed SSR expose, i.e. the boundaries the shell must server-render.
 */
export const planWorkerdSsrProof = (topology) => {
  assert(
    topology?.schemaVersion === 1 && topology.shell && Array.isArray(topology.verticals),
    "Invalid topology/reference-topology.json",
  );
  const rawApps = [topology.shell, ...topology.verticals, ...(topology.shells ?? [])];
  const rawAppsById = new Map(rawApps.map((rawApp) => [String(rawApp.id), rawApp]));
  const plans = rawApps.map((rawApp) => {
    const id = String(rawApp.id);
    const kind = rawApp.kind === "vertical" ? "vertical" : "shell";
    const cloudflare = rawApp.cloudflare ?? {};
    const declaredServerRenderedRoutes = cloudflare.distributedSsrProofRoutes;
    const rawVerticalRefs = rawApp.verticalRefs ?? rawApp.moduleFederation?.verticalRefs;
    const verticalRefs = Array.isArray(rawVerticalRefs)
      ? rawVerticalRefs.filter((ref) => typeof ref === "string")
      : [];
    for (const ref of verticalRefs) {
      assert(rawAppsById.has(ref), `${id} references missing MicroVertical ${ref}`);
    }
    const serverRenderedRemoteIds =
      kind === "shell"
        ? verticalRefs.filter((ref) => declaresDistributedSsrExpose(rawAppsById.get(ref)))
        : [];
    assert(
      declaredServerRenderedRoutes === undefined ||
        (Array.isArray(declaredServerRenderedRoutes) &&
          normalizeRoutes(declaredServerRenderedRoutes).length ===
            declaredServerRenderedRoutes.length),
      `${id} cloudflare.distributedSsrProofRoutes must list unique absolute routes`,
    );
    const serverRenderedRoutes =
      kind !== "shell"
        ? []
        : Array.isArray(declaredServerRenderedRoutes)
          ? normalizeRoutes(declaredServerRenderedRoutes)
          : normalizeRoutes([cloudflare.routes?.ssr]);
    const ssrRoutes = normalizeRoutes([
      ...(Array.isArray(declaredServerRenderedRoutes) ? declaredServerRenderedRoutes : []),
      cloudflare.routes?.ssr,
    ]);
    const apiOnly = rawApp.surfaceProfile === "api-only";
    assert(
      apiOnly || normalizeRoutes([cloudflare.routes?.ssr]).length === 1,
      `${id} declares no cloudflare.routes.ssr to prove on its own Worker`,
    );
    return {
      apiOnly,
      id,
      kind,
      serverRenderedRemoteIds:
        serverRenderedRoutes.length > 0 ? serverRenderedRemoteIds : [],
      serverRenderedRoutes,
      ssrRoutes,
      verticalRefs,
    };
  });
  assert(
    plans.some((plan) => plan.kind === "shell"),
    "Workerd SSR proof requires at least one shell",
  );
  assert(
    plans.some((plan) => plan.kind === "vertical"),
    "Workerd SSR proof requires at least one MicroVertical or headless API",
  );
  return { plans, rawApps };
};

const readDevVars = (outputRoot) => {
  // Wrangler's local-secret convention: `.dev.vars` beside the executed config.
  const devVarsPath = path.join(outputRoot, ".dev.vars");
  return fs.existsSync(devVarsPath) ? parseEnv(fs.readFileSync(devVarsPath, "utf8")) : {};
};

// A topology path names one app directory below the selected root. Built
// artifacts may live in a separate root (ULTRAMODERN_WORKERD_ARTIFACT_ROOT),
// but a topology path must never select output outside it.
// Release envelope surfaces a unit may carry, from its topology profile. A
// MicroVertical's profile fixes its API backend and backend federation pair. A
// Shell never publishes backend federation; unless it is `ui-only` it may own
// an API backend of its own (its BFF), which must then be bound like any other.
export const expectedEnvelopeSurfaces = (kind, surfaceProfile) => {
  const allowsApi = surfaceProfile !== "ui-only";
  return {
    apiBackend:
      kind === "vertical"
        ? allowsApi ? "required" : "forbidden"
        : allowsApi ? "optional" : "forbidden",
    backendFederation: kind === "vertical" && allowsApi,
    uiClient: surfaceProfile !== "api-only",
  };
};

const matchesSurface = (expected, present) =>
  expected === "optional" || present === (expected === "required");

export const resolveAppOutputRoot = (artifactRoot, appId, appPath) => {
  assert(typeof appPath === "string" && appPath.length > 0, `${appId} topology path is missing`);
  const segments = normalizePath(appPath).split("/");
  const outputRoot = path.resolve(artifactRoot, appPath, ".output");
  const relativeOutput = path.relative(artifactRoot, outputRoot);
  assert(
    !path.isAbsolute(appPath) &&
      !path.posix.isAbsolute(normalizePath(appPath)) &&
      !segments.includes("..") &&
      relativeOutput !== ".output" &&
      relativeOutput !== `..` &&
      !relativeOutput.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeOutput),
    `${appId} topology path ${appPath} escapes the selected artifact root`,
  );
  return outputRoot;
};

const loadApps = async (workspaceRoot, artifactRoot, topology, overlay) => {
  const { plans, rawApps } = planWorkerdSsrProof(topology);
  return Promise.all(rawApps.map(async (rawApp, index) => {
    const plan = plans[index];
    const expectedSurfaces = expectedEnvelopeSurfaces(plan.kind, rawApp.surfaceProfile);
    // A MicroVertical API that the Shell reaches through a service binding.
    const hasApiSurface = expectedSurfaces.backendFederation;
    const appPath = rawApp.path;
    const outputRoot = resolveAppOutputRoot(artifactRoot, plan.id, appPath);
    const wranglerPath = path.join(outputRoot, "wrangler.json");
    assert(
      fs.existsSync(wranglerPath),
      `${plan.id} Cloudflare output is missing; run pnpm cloudflare:build first`,
    );
    const wrangler = readJson(wranglerPath);
    const domain = rawApp.domain ?? rawApp.id;
    const portEnv = rawApp.portEnv ??
      (plan.kind === "vertical"
        ? `VERTICAL_${String(domain).replace(/[^a-zA-Z0-9]/gu, "_").toUpperCase()}_PORT`
        : undefined);
    assert(typeof portEnv === "string" && portEnv.length > 0, `${plan.id} has no declared port environment name`);
    const configuredPort = process.env[portEnv];
    const port = configuredPort === undefined
      ? Number(overlay.ports?.[plan.id])
      : Number(configuredPort);
    assert(
      Number.isInteger(port) && port > 0 && port <= 65535,
      `${plan.id} has an invalid local proof port from ${portEnv}`,
    );
    // Every executed Worker is bound to its owner-verified release envelope,
    // and the envelope surfaces must match the declared application profile.
    const executedEnvelope = await readExecutionEnvelope(
      plan.id,
      path.join(workspaceRoot, appPath),
      outputRoot,
      rawApp.deliveryUnit?.unitId,
    );
    const { surfaces } = executedEnvelope.envelope;
    assert(
      matchesSurface(expectedSurfaces.apiBackend, surfaces.apiBackend.length > 0) &&
        Boolean(surfaces.backendFederation) === expectedSurfaces.backendFederation &&
        (surfaces.uiClient.length > 0) === expectedSurfaces.uiClient,
      `${plan.id} executed envelope surfaces differ from its declared application profile`,
    );

    return {
      ...plan,
      hasApiSurface,
      ownsApiBackend: surfaces.apiBackend.length > 0,
      path: appPath,
      apiPrefix:
        typeof rawApp.api?.bff?.prefix === "string"
          ? rawApp.api.bff.prefix.replace(/\/+$/u, "")
          : undefined,
      apiProtocol: rawApp.api?.protocol ?? "rest",
      rpcRoute: rawApp.api?.protocol === "rpc" ? rawApp.cloudflare?.routes?.rpc : undefined,
      ssrHtmlMaxBytes: Number(
        rawApp.cloudflare?.qualityGates?.budgets?.ssrHtmlMaxBytes ??
          defaultSsrHtmlMaxBytes,
      ),
      jsonSmokeChecks: Array.isArray(rawApp.cloudflare?.jsonSmokeChecks)
        ? rawApp.cloudflare.jsonSmokeChecks
        : [],
      ...executedEnvelope,
      devVars: readDevVars(outputRoot),
      outputRoot,
      port,
      wrangler,
    };
  }));
};

const workerName = (app) => {
  assert(
    typeof app.wrangler.name === "string" && app.wrangler.name.length > 0,
    `${app.id} wrangler output must define a worker name`,
  );
  return app.wrangler.name;
};

// Wrangler's local Hyperdrive convention: a binding's local PostgreSQL comes from
// CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING> (the app's .dev.vars, then the proof's
// environment), else its `localConnectionString`.
const createLocalHyperdrives = (app) => {
  const hyperdrive = Array.isArray(app.wrangler.hyperdrive) ? app.wrangler.hyperdrive : [];
  return Object.fromEntries(
    hyperdrive.map((entry) => {
      assert(
        typeof entry?.binding === "string" && entry.binding.length > 0,
        `${app.id} has an invalid Hyperdrive binding`,
      );
      const variable = `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${entry.binding}`;
      const connectionString =
        app.devVars[variable] || process.env[variable] || entry.localConnectionString;
      assert(
        typeof connectionString === "string" && connectionString.length > 0,
        `${app.id} Hyperdrive binding ${entry.binding} needs a local PostgreSQL connection string; set ${variable}`,
      );
      return [entry.binding, connectionString];
    }),
  );
};

const emptyWorkerdProofFixture = Object.freeze({
  schemaVersion: 1,
  kvSeeds: [],
  ownerTargets: [],
  shellApiTargets: [],
});
const httpHeaderName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/**
 * Validate the runtime data a workspace supplies through
 * ULTRAMODERN_WORKERD_PROOF_FIXTURE (schemaVersion 1):
 *
 * - `kvSeeds[]`: `{ appId, binding, entries: [{ key, value }] }`. Each seed
 *   names a `kv_namespaces` binding of an executed Worker's wrangler.json; the
 *   string entries are written to that native namespace before any request.
 *   Workers sharing a namespace id share its entries, so seeds must agree.
 * - `ownerTargets[]`: `{ appId, baseUrl }`. A MicroVertical's approved HTTPS
 *   origin (`https://host[:port]/`). A Worker's outbound fetch to that origin
 *   is served by the owner's Worker; every other origin stays disabled.
 * - `shellApiTargets[]`: `{ shellId, appId, routePrefix, headers }`. The shell
 *   mounts the owner API under `routePrefix`; each API smoke check is sent to
 *   the shell at `routePrefix + route` with `headers`, and must reach the
 *   owner's `baseUrl + route` and return the owner's status, content type and
 *   body unchanged. Redirects are not followed. An API app without a Shell API
 *   target is proven through the shell's service binding.
 *
 * The proof only executes this data; it never derives it from topology.
 */
export const validateWorkerdProofFixture = (fixture, apps) => {
  assert(
    fixture?.schemaVersion === 1 &&
      Array.isArray(fixture.kvSeeds) &&
      Array.isArray(fixture.ownerTargets) &&
      Array.isArray(fixture.shellApiTargets),
    "Invalid Workerd proof fixture",
  );
  const appsById = new Map(apps.map((app) => [app.id, app]));
  const seededKeys = new Set();
  const sharedValues = new Map();
  for (const seed of fixture.kvSeeds) {
    const app = appsById.get(seed?.appId);
    const namespace = Array.isArray(app?.wrangler.kv_namespaces)
      ? app.wrangler.kv_namespaces.find((candidate) => candidate?.binding === seed.binding)
      : undefined;
    assert(
      typeof seed?.binding === "string" && namespace && Array.isArray(seed.entries),
      "Workerd proof KV seed must name an executed Worker's declared kv_namespaces binding",
    );
    for (const entry of seed.entries) {
      const seededKey = JSON.stringify([seed.appId, seed.binding, entry?.key]);
      assert(
        typeof entry?.key === "string" &&
          entry.key.length > 0 &&
          typeof entry.value === "string" &&
          !seededKeys.has(seededKey),
        "Workerd proof KV seeds must contain unique string keys with string values",
      );
      seededKeys.add(seededKey);
      const sharedKey = JSON.stringify([namespace.id, entry.key]);
      assert(
        !sharedValues.has(sharedKey) || sharedValues.get(sharedKey) === entry.value,
        "Workerd proof KV seeds must not conflict in a shared namespace",
      );
      sharedValues.set(sharedKey, entry.value);
    }
  }
  const ownerOrigins = new Set();
  const ownerIds = new Set();
  for (const target of fixture.ownerTargets) {
    const app = appsById.get(target?.appId);
    const url = typeof target?.baseUrl === "string" ? URL.parse(target.baseUrl) : null;
    assert(
      app?.kind === "vertical" &&
        url?.protocol === "https:" &&
        target.baseUrl === `${url.origin}/` &&
        !ownerOrigins.has(url.origin) &&
        !ownerIds.has(app.id),
      "Workerd proof owner targets must be unique executed MicroVerticals at canonical HTTPS origins",
    );
    ownerOrigins.add(url.origin);
    ownerIds.add(app.id);
  }
  const mounts = new Set();
  for (const target of fixture.shellApiTargets) {
    const shell = appsById.get(target?.shellId);
    const app = appsById.get(target?.appId);
    const mount = JSON.stringify([target?.shellId, target?.appId]);
    const { routePrefix, headers } = target ?? {};
    assert(
      shell?.kind === "shell" &&
        app?.hasApiSurface === true &&
        ownerIds.has(app.id) &&
        typeof routePrefix === "string" &&
        routePrefix.startsWith("/") &&
        !routePrefix.endsWith("/") &&
        !/[?#\\]|%(?:2f|5c)/iu.test(routePrefix) &&
        !routePrefix.split("/").some((segment) => segment === "." || segment === "..") &&
        headers !== null &&
        typeof headers === "object" &&
        !Array.isArray(headers) &&
        Object.entries(headers).every(
          ([name, value]) =>
            httpHeaderName.test(name) && typeof value === "string" && !/[\r\n]/u.test(value),
        ) &&
        !mounts.has(mount),
      "Workerd proof Shell API targets must name one approved owner, an explicit mount and string headers",
    );
    mounts.add(mount);
  }
  return fixture;
};

const readWorkerdProofFixture = (apps) => {
  const location = process.env.ULTRAMODERN_WORKERD_PROOF_FIXTURE;
  return location === undefined || location === ""
    ? emptyWorkerdProofFixture
    : validateWorkerdProofFixture(readJson(path.resolve(location)), apps);
};

// Wrangler's kv_namespaces binding -> namespace id, as `wrangler dev` binds
// local KV storage.
const createKvNamespaces = (app) => {
  const namespaces = app.wrangler.kv_namespaces ?? [];
  assert(Array.isArray(namespaces), `${app.id} wrangler kv_namespaces must be an array`);
  return Object.fromEntries(
    namespaces.map((namespace) => {
      assert(
        typeof namespace?.binding === "string" &&
          namespace.binding.length > 0 &&
          typeof namespace.id === "string" &&
          namespace.id.length > 0,
        `${app.id} has an invalid KV namespace binding`,
      );
      return [namespace.binding, namespace.id];
    }),
  );
};

// Write fixture KV entries into every namespace the runtime's Workers bind.
// Workers bound to one namespace id share storage, so each id is seeded once.
const seedWorkerdProofKv = async (miniflare, runtimeApps, apps, fixture) => {
  const entriesByNamespace = new Map();
  for (const seed of fixture.kvSeeds) {
    const owner = apps.find((candidate) => candidate.id === seed.appId);
    const { id } = owner.wrangler.kv_namespaces.find(
      (namespace) => namespace.binding === seed.binding,
    );
    const entries = entriesByNamespace.get(id) ?? new Map();
    for (const entry of seed.entries) entries.set(entry.key, entry.value);
    entriesByNamespace.set(id, entries);
  }
  const seeded = new Set();
  for (const app of runtimeApps) {
    for (const { binding, id } of app.wrangler.kv_namespaces ?? []) {
      const entries = entriesByNamespace.get(id);
      if (entries === undefined || seeded.has(id)) continue;
      const namespace = await miniflare.getKVNamespace(binding, workerName(app));
      for (const [key, value] of entries) {
        await namespace.put(key, value);
        assert(
          (await namespace.get(key)) === value,
          `${app.id} KV namespace ${binding} did not keep seeded key ${key}`,
        );
      }
      seeded.add(id);
    }
  }
};

const createWorkerOptions = (app, artifactRoot, extra = {}) => {
  const main = typeof app.wrangler.main === "string" ? app.wrangler.main : "server/index.mjs";
  const assets =
    app.wrangler.assets && typeof app.wrangler.assets === "object" ? app.wrangler.assets : {};
  const directory = typeof assets.directory === "string" ? assets.directory : "./public";

  const modules = createWorkerModules(app.outputRoot, main);
  const boundModules = modules.map((module) =>
    bindExecutedModule(app, app.envelope, module),
  );
  const mainLogicalPath = normalizePath(
    path.relative(app.outputRoot, path.resolve(app.outputRoot, main)),
  );
  assert(
    boundModules.some((module) => module.logicalPath === mainLogicalPath),
    `${app.id} Miniflare main ${mainLogicalPath} is not in the selected module set`,
  );
  const { apiBackend, ssr } = app.envelope.surfaces;
  assert(
    !app.ownsApiBackend ||
      (Array.isArray(apiBackend) &&
        apiBackend.length > 0 &&
        apiBackend.every((logicalPath) =>
          boundModules.some((module) => module.logicalPath === logicalPath),
        )),
    `${app.id} BFF worker surface is not selected by Miniflare`,
  );
  assert(
    Array.isArray(ssr) &&
      (app.apiOnly
        ? ssr.length === 0 && mainLogicalPath === "server/index.mjs"
        : ssr.includes(mainLogicalPath)) &&
      boundModules.every((module) =>
        [...ssr, ...apiBackend, ...(app.apiOnly ? [mainLogicalPath] : [])]
          .includes(module.logicalPath),
      ),
    `${app.id} Miniflare main/SSR modules do not match its envelope surfaces`,
  );

  return {
    executionEvidence: {
      appId: app.id,
      apiBackend,
      envelopeDigest: app.envelope.envelopeDigest,
      envelopePath: normalizePath(path.relative(artifactRoot, app.envelopePath)),
      identity: app.envelope.identity,
      main: mainLogicalPath,
      modules: boundModules,
      modulesRoot: normalizePath(path.relative(artifactRoot, app.outputRoot)),
      worker: workerName(app),
    },
    name: workerName(app),
    modules,
    modulesRoot: app.outputRoot,
    compatibilityDate: app.wrangler.compatibility_date,
    compatibilityFlags: app.wrangler.compatibility_flags,
    bindings: { ...app.wrangler.vars, ...app.devVars },
    hyperdrives: createLocalHyperdrives(app),
    kvNamespaces: createKvNamespaces(app),
    assets: {
      binding: typeof assets.binding === "string" ? assets.binding : "ASSETS",
      directory: path.resolve(app.outputRoot, directory),
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: assets.run_worker_first !== false,
      },
    },
    ...extra,
  };
};

const findReleaseMarkers = (value, markers = []) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      findReleaseMarkers(item, markers);
    }
    return markers;
  }
  if (!value || typeof value !== "object") {
    return markers;
  }
  if (
    value.marker &&
    typeof value.marker === "object" &&
    typeof value.marker.build === "string"
  ) {
    markers.push(value.marker);
  }
  for (const nested of Object.values(value)) {
    findReleaseMarkers(nested, markers);
  }
  return markers;
};

const jsonPathValue = (value, key) =>
  String(key).split(".").reduce((current, segment) => current?.[segment], value);

// A bounded summary of an RFC 9457-style problem body, or an Effect tagged error.
const problemSummary = (body) => {
  const problem = {};
  for (const key of ["type", "title", "code", "_tag"]) {
    if (typeof body?.[key] === "string") problem[key] = body[key].slice(0, 200);
  }
  if (Number.isFinite(body?.status)) problem.status = body.status;
  return problem;
};

const responseEvidence = async (app, response, check, phase) => {
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type");
  let body;
  let parseError;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    parseError = error;
  }
  assert(
    response.ok,
    `${app.id} ${phase} API response returned HTTP ${response.status}: ${JSON.stringify({
      phase,
      status: response.status,
      contentType,
      sha256: sha256(bytes),
      problem: problemSummary(body),
    })}`,
  );
  if (parseError !== undefined) {
    throw new Error(`${app.id} ${phase} API response is not JSON: ${parseError.message}`);
  }
  let marker;
  if (app.apiProtocol === "rpc") {
    assert(
      typeof app.rpcRoute === "string" && app.rpcRoute.startsWith("/") &&
        check.route === app.rpcRoute && String(check.method).toUpperCase() === "POST" &&
        check.body?.jsonrpc === "2.0" && check.body?.id !== undefined &&
        body?.jsonrpc === "2.0" && body.id === check.body.id,
      `${app.id} RPC response does not match its declared POST request`,
    );
    assert(
      check.expect && Object.keys(check.expect).length > 0 &&
        Object.entries(check.expect).every(([key, expected]) =>
          JSON.stringify(jsonPathValue(body, key)) === JSON.stringify(expected)),
      `${app.id} RPC response does not satisfy its declared JSON smoke check`,
    );
  } else {
    const markers = findReleaseMarkers(body);
    marker = markers.find(
      (candidate) =>
        candidate.appId === app.id &&
        candidate.build === app.envelope.identity.buildMarker &&
        candidate.version === app.envelope.identity.releaseVersion,
    );
    assert(marker, `${app.id} API response is not tied to its executed release identity`);
  }
  return {
    bodyBase64: bytes.toString("base64"),
    byteLength: bytes.byteLength,
    contentType,
    ...(marker ? { releaseMarker: marker } : {}),
    sha256: sha256(bytes),
    status: response.status,
  };
};

const resolveApiSmokeChecks = (app, shell) => {
  const shellChecks =
    typeof app.apiPrefix === "string" && app.apiPrefix.startsWith("/")
      ? shell.jsonSmokeChecks.filter(
          (check) =>
            typeof check?.route === "string" &&
            (check.route === app.apiPrefix ||
              check.route.startsWith(`${app.apiPrefix}/`)),
        )
      : [];
  const checks = [...app.jsonSmokeChecks, ...shellChecks];
  const uniqueChecks = new Map();
  for (const check of checks) {
    const key = JSON.stringify([
      String(check.method ?? "GET").toUpperCase(),
      check.route,
      check.body ?? null,
      check.expect ?? null,
      check.id ?? null,
    ]);
    if (!uniqueChecks.has(key)) {
      uniqueChecks.set(key, check);
    }
  }
  return [...uniqueChecks.values()];
};

const responseSummary = ({ contentType, sha256: digest, status }) => ({
  contentType,
  sha256: digest,
  status,
});

const runApiProofs = async (apps, miniflare, shell, executionByAppId, fixture, recorders) => {
  const results = [];
  for (const app of apps.filter((candidate) => candidate.hasApiSurface)) {
    const jsonSmokeChecks = resolveApiSmokeChecks(app, shell);
    assert(
      jsonSmokeChecks.length > 0,
      `${app.id} has no real Cloudflare API smoke check`,
    );
    // The shell reaches an owner API through the fixture's explicit HTTPS
    // mount, or else through its declared service binding.
    const shellTarget = fixture.shellApiTargets.find(
      (candidate) => candidate.shellId === shell.id && candidate.appId === app.id,
    );
    const ownerTarget = fixture.ownerTargets.find((candidate) => candidate.appId === app.id);
    const binding = shellTarget
      ? undefined
      : (shell.wrangler.services ?? []).find(
          (candidate) => candidate.service === workerName(app),
        );
    assert(
      shellTarget || binding || (app.apiOnly && !shell.verticalRefs.includes(app.id)),
      `${shell.id} has no service binding or Shell API target for ${app.id}`,
    );
    for (const check of jsonSmokeChecks) {
      const method = String(check.method ?? "GET").toUpperCase();
      const headers = {};
      // A redirect is the response under proof, never a hop to follow.
      const init = { method, headers, redirect: "manual" };
      if (check.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(check.body);
      }
      const direct = await responseEvidence(
        app,
        await (
          await miniflare.getWorker(workerName(app))
        ).fetch(`https://${workerName(app)}.invalid${check.route}`, init),
        check,
        "direct",
      );
      const outboundRequestStart = recorders.outboundRequests.length;
      const shellRoute = shellTarget ? `${shellTarget.routePrefix}${check.route}` : check.route;
      const throughShell = shellTarget || binding
        ? await responseEvidence(
            app,
            await miniflare.dispatchFetch(`https://${workerName(shell)}.invalid${shellRoute}`, {
              ...init,
              headers: { ...headers, ...shellTarget?.headers },
            }),
            check,
            "through-shell",
          )
        : undefined;
      if (throughShell) {
        assert(
          direct.status === throughShell.status &&
            direct.sha256 === throughShell.sha256 &&
            direct.contentType === throughShell.contentType,
          `${app.id} direct and through-shell API responses differ: ${JSON.stringify({
            direct: responseSummary(direct),
            throughShell: responseSummary(throughShell),
          })}`,
        );
      }
      const outboundRequests = recorders.outboundRequests.slice(outboundRequestStart);
      if (shellTarget) {
        const ownerUrl = new URL(check.route, ownerTarget.baseUrl).href;
        assert(
          outboundRequests.some(
            (request) =>
              request.callerId === shell.id &&
              request.targetAppId === app.id &&
              request.url === ownerUrl &&
              request.method === method &&
              request.response?.status === throughShell.status,
          ),
          `${app.id} Shell API proof did not reach its approved HTTPS owner at ${ownerUrl}: ${JSON.stringify(outboundRequests)}`,
        );
      }
      const target = {
        appId: app.id,
        envelopeDigest: executionByAppId.get(app.id).envelopeDigest,
        worker: workerName(app),
      };
      results.push({
        appId: app.id,
        shellId: shell.id,
        ...(shellTarget
          ? {
              httpsTarget: { ...target, baseUrl: ownerTarget.baseUrl },
              outboundRequests,
              shellRoute,
              throughShell,
            }
          : binding
            ? { binding: binding.binding, bindingTarget: target, throughShell }
            : { directTarget: target }),
        direct,
        id: check.id,
        method,
        route: check.route,
      });
    }
  }
  return results;
};

const readRequestBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
};

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });

// Bind the actual public listeners before any runtime can allocate ephemeral
// ports. Keep these sockets until shutdown: releasing reservations and rebinding
// would reintroduce the allocation race (compiled public URLs cannot change).
export const withWorkerdTargetServers = async (apps, run) => {
  const servers = [];
  const isolatedVerticalRuntimes = [];
  const runtimes = new Map();
  const targetUrls = {};
  let ready = false;
  let failedServices;
  let stopping;
  const stop = () => stopping ??= (async () => {
    ready = false;
    await Promise.allSettled(servers.map(closeServer));
    await Promise.allSettled(
      isolatedVerticalRuntimes.map((runtime) => runtime.dispose()),
    );
  })();
  try {
    for (const app of apps) {
      assert(
        Number.isInteger(app.port) && app.port > 0,
        `${app.id} requires a configured local port for all-workerd browser proof`,
      );
      const server = http.createServer(async (incoming, outgoing) => {
        try {
          if (!ready) {
            outgoing.writeHead(503, { "content-type": "text/plain" });
            outgoing.end("Workerd proof runtime is not ready");
            return;
          }
          const body = await readRequestBody(incoming);
          if (
            incoming.method === "POST" &&
            incoming.url === "/_ultramodern-proof/service-binding-fault"
          ) {
            const command = JSON.parse(body?.toString("utf8") ?? "{}");
            const targetApp = apps.find((candidate) => candidate.id === command.appId);
            assert(targetApp, `Unknown service-binding fault target ${String(command.appId)}`);
            const service = workerName(targetApp);
            if (command.failed === true) {
              failedServices.add(service);
            } else {
              failedServices.delete(service);
            }
            outgoing.writeHead(200, { "content-type": "application/json" });
            outgoing.end(JSON.stringify({ failed: failedServices.has(service), service }));
            return;
          }
          // Miniflare's WorkerFetcher owns its own Request implementation.
          // Passing a Node-global Request across that realm boundary makes
          // Miniflare stringify it as "[object Request]" and reject the URL.
          // Keep the internal URL on the target Worker's canonical fake host
          // so Miniflare also selects that Worker's asset namespace.
          const runtime = runtimes.get(app.id);
          const response = await runtime.dispatchFetch(
            `https://${workerName(app)}.invalid${incoming.url ?? "/"}`,
            {
              ...(body === undefined ? {} : { body }),
              headers: incoming.headers,
              method: incoming.method,
            },
          );
          outgoing.writeHead(
            response.status,
            Object.fromEntries(response.headers.entries()),
          );
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          outgoing.end(error instanceof Error ? error.stack ?? error.message : String(error));
        }
      });
      servers.push(server);
      await listen(server, app.port);
      targetUrls[app.id] = `http://127.0.0.1:${app.port}`;
    }
    return await run({
      targetUrls,
      stop,
      async start(miniflare, failures, workerConfigurations, fixture) {
        failedServices = failures;
        for (const [index, app] of apps.entries()) {
          const runtime = app.kind === "vertical"
            ? await createIsolatedRuntime(
                workerConfigurations[index], new ProofLog(), app, apps, fixture,
              )
            : miniflare;
          if (runtime !== miniflare) isolatedVerticalRuntimes.push(runtime);
          // Readiness must include actual Worker startup, not just a bound socket.
          await runtime.ready;
          runtimes.set(app.id, runtime);
        }
        ready = true;
      },
    });
  } finally {
    await stop();
  }
};

const readAttribute = (tag, name) => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`\\s${escapedName}=(?:"([^"]*)"|'([^']*)')`, "u").exec(tag);
  return match?.[1] ?? match?.[2];
};

const collectDistributedBoundaries = (html) =>
  [...html.matchAll(/<[a-z][^>]*data-modern-distributed-ssr-boundary=(?:"[^"]+"|'[^']+')[^>]*>/giu)].map(
    (match) => {
      const tag = match[0];
      const key = readAttribute(tag, "data-modern-distributed-ssr-boundary");
      const separator = key?.indexOf("::") ?? -1;
      assert(separator > 0, `Invalid distributed SSR boundary key ${key}`);
      return {
        buildMarker: readAttribute(tag, "data-modern-distributed-ssr-build"),
        digest: readAttribute(tag, "data-modern-distributed-ssr-digest"),
        expose: key.slice(separator + 2),
        key,
        remote: key.slice(0, separator),
        status: readAttribute(tag, "data-modern-distributed-ssr-status"),
      };
    },
  );

const collectStylesheetHrefs = (html) =>
  [...html.matchAll(/<link\b[^>]*>/giu)]
    .filter((match) => readAttribute(match[0], "rel")?.split(/\s+/u).includes("stylesheet"))
    .map((match) => readAttribute(match[0], "href"))
    .filter(Boolean);

const isDistributedSsrFragmentRequest = (request) =>
  request.headers.get(DISTRIBUTED_SSR_FRAGMENT_REQUEST_HEADER) === "1";

const readRequiredFragmentHeader = (request, header) => {
  const value = request.headers.get(header);
  assert(
    typeof value === "string" && value.length > 0,
    `Distributed SSR fragment request is missing ${header}`,
  );
  return value;
};

const decodeDistributedSsrFragmentRequest = (request) => {
  assert(
    isDistributedSsrFragmentRequest(request),
    "Distributed SSR fragment request is missing its request marker",
  );
  assert(
    request.method === "GET",
    `Distributed SSR fragment request must use GET, received ${request.method}`,
  );

  const headers = Object.fromEntries(
    DISTRIBUTED_SSR_REQUIRED_HEADERS.map((header) => [
      header,
      readRequiredFragmentHeader(request, header),
    ]),
  );
  const props = JSON.parse(
    decodeURIComponent(headers["x-modern-distributed-ssr-props"]),
  );
  assert(props && typeof props === "object" && !Array.isArray(props), "Fragment props must be an object");
  const sourceUrl = headers["x-modern-distributed-ssr-source-url"];
  try {
    new URL(sourceUrl);
  } catch {
    throw new Error("Distributed SSR fragment source URL must be absolute");
  }

  return {
    boundaryId: headers["x-modern-distributed-ssr-boundary-id"],
    expose: headers["x-modern-distributed-ssr-expose"],
    props,
    remote: headers["x-modern-distributed-ssr-remote"],
    sourceUrl,
  };
};

// Miniflare assigns one shared assets storage service inside a multi-worker
// instance. Keep the shell composition runtime intact, but give every directly
// requested MicroVertical its own runtime so its static assets and MF manifest
// cannot resolve from a sibling Worker. Its service bindings still resolve
// through the shared composition runtime. Its KV namespaces are its own, so
// they receive the fixture seeds again.
const createIsolatedRuntime = async (workerOptions, log, app, apps, fixture) => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      log,
      workers: [workerOptions],
    }),
  );
  try {
    await seedWorkerdProofKv(runtime, [app], apps, fixture);
    return runtime;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
};

const createServiceBindings = (
  caller,
  { apiBindingRequests, composition, failedServices, fragmentBindingRequests },
) => {
  const services = Array.isArray(caller.wrangler.services) ? caller.wrangler.services : [];
  return Object.fromEntries(
    services.map((service) => {
      assert(
        typeof service.binding === "string" && typeof service.service === "string",
        `${caller.id} has an invalid service binding`,
      );
      return [
        service.binding,
        async (request) => {
          if (failedServices.has(service.service)) {
            throw new Error(
              `Injected unavailable service binding ${service.binding} -> ${service.service}`,
            );
          }
          const requestUrl = new URL(request.url);
          let apiBindingRequest;
          if (isDistributedSsrFragmentRequest(request)) {
            const fragment = decodeDistributedSsrFragmentRequest(request);
            fragmentBindingRequests.push({
              binding: service.binding,
              boundaryId: fragment.boundaryId,
              callerId: caller.id,
              expose: fragment.expose,
              method: request.method,
              pathname: requestUrl.pathname,
              props: fragment.props,
              remote: fragment.remote,
              service: service.service,
              sourceUrl: fragment.sourceUrl,
            });
          } else {
            apiBindingRequest = {
              binding: service.binding,
              callerId: caller.id,
              method: request.method,
              pathname: requestUrl.pathname,
              requestBody: {
                contentLength: request.headers.get("content-length"),
                contentType: request.headers.get("content-type"),
                present: request.body !== null,
              },
              service: service.service,
            };
            apiBindingRequests.push(apiBindingRequest);
          }
          const target = await composition.miniflare.getWorker(service.service);
          const response = await target.fetch(request);
          if (apiBindingRequest !== undefined) {
            apiBindingRequest.response = {
              contentType: response.headers.get("content-type"),
              status: response.status,
            };
          }
          return response;
        },
      ];
    }),
  );
};

const proveRoute = async (app, route, fetchRoute, apps, recorders, log) => {
  const apiBindingRequestStart = recorders.apiBindingRequests.length;
  const fragmentBindingRequestStart = recorders.fragmentBindingRequests.length;
  const outboundRequestStart = recorders.outboundRequests.length;
  const response = await fetchRoute(`https://${workerName(app)}.invalid${route}`, {
    headers: { accept: "text/html" },
  });
  const html = await response.text();
  const htmlBytes = Buffer.byteLength(html);
  const routeOutboundRequests = recorders.outboundRequests.slice(outboundRequestStart);
  assertSuccessfulSsrResponse(app.id, route, response, html, log, routeOutboundRequests);
  assert(
    response.headers.get("content-type")?.includes("text/html") === true,
    `${app.id} did not return HTML for ${route} in workerd`,
  );
  // Runaway server rendering (for example a worker re-rendering its own
  // route data requests) can still end in an oversized document.
  assert(
    htmlBytes <= app.ssrHtmlMaxBytes,
    `${app.id} rendered ${htmlBytes} bytes for ${route} in workerd, over the ${app.ssrHtmlMaxBytes} byte ssrHtmlMaxBytes budget`,
  );
  assert(
    !html.includes('data-modern-distributed-ssr-status="degraded"'),
    `${app.id} rendered a degraded MicroVertical fallback for ${route} in workerd`,
  );

  const boundaries = collectDistributedBoundaries(html);
  const routeApiBindingRequests = recorders.apiBindingRequests.slice(apiBindingRequestStart);
  const routeFragmentBindingRequests = recorders.fragmentBindingRequests.slice(
    fragmentBindingRequestStart,
  );
  for (const boundary of boundaries) {
    assert(
      boundary.status === "ready",
      `${app.id} did not mark ${boundary.key} as ready for ${route}`,
    );
    assert(
      typeof boundary.buildMarker === "string" && boundary.buildMarker.length > 0,
      `${app.id} ${boundary.key} is missing immutable build provenance`,
    );
    assert(
      /^[a-f\d]{64}$/u.test(boundary.digest ?? ""),
      `${app.id} ${boundary.key} is missing a verified SHA-256 digest`,
    );
    const remote = apps.find((candidate) => candidate.id === boundary.remote);
    assert(remote, `${app.id} rendered unknown remote ${boundary.remote}`);
    const requests = routeFragmentBindingRequests.filter(
      (request) =>
        request.service === workerName(remote) &&
        request.remote === boundary.remote &&
        request.expose === boundary.expose,
    );
    const renderedCount = boundaries.filter(
      (candidate) => candidate.key === boundary.key,
    ).length;
    assert(
      requests.length === renderedCount &&
        requests.every((request) => request.pathname.includes("/_mf/fragment/")),
      `${app.id} must compose each ${boundary.key} occurrence through its remote service binding`,
    );
  }

  const stylesheetHrefs = collectStylesheetHrefs(html);
  assert(
    new Set(stylesheetHrefs).size === stylesheetHrefs.length,
    `${app.id} rendered duplicate distributed SSR stylesheets for ${route}`,
  );
  assert(
    !routeOutboundRequests.some(({ url }) => /(?:remoteEntry|\.m?js(?:\?|$))/u.test(url)),
    `${app.id} attempted to fetch remote JavaScript during ${route} server rendering`,
  );

  return {
    worker: workerName(app),
    route,
    status: response.status,
    htmlBytes,
    boundaries,
    fragmentBindingRequests: routeFragmentBindingRequests,
    apiBindingRequests: routeApiBindingRequests,
    outboundRequests: routeOutboundRequests,
    stylesheetHrefs,
    degradedBoundaryCount: count(html, 'data-modern-distributed-ssr-status="degraded"'),
  };
};

const writeReport = (reportPath, report) => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 3,
        runtime: "workerd",
        routes: [...new Set(report.proofs.map((proof) => proof.route))],
        ...report,
      },
      null,
      2,
    )}\n`,
  );
};

const main = async () => {
  const workspaceRoot = path.resolve(process.env.ULTRAMODERN_WORKSPACE_ROOT ?? process.cwd());
  // Built `.output` directories may live outside the workspace, for example
  // when a release job proves downloaded artifacts. Topology still comes from
  // the workspace.
  const artifactRoot = path.resolve(
    process.env.ULTRAMODERN_WORKERD_ARTIFACT_ROOT || workspaceRoot,
  );
  const reportPath = path.join(workspaceRoot, reportRelativePath);
  const keepWorkerd = process.env.ULTRAMODERN_KEEP_WORKERD === "1";
  const apps = await loadApps(
    workspaceRoot,
    artifactRoot,
    readJson(path.join(workspaceRoot, "topology/reference-topology.json")),
    readJson(path.join(workspaceRoot, "topology/local-overlays/development.json")),
  );
  const shells = apps.filter((app) => app.kind === "shell");
  assert(!keepWorkerd || shells.length === 1, "Browser workerd proof requires exactly one shell");
  const fixture = readWorkerdProofFixture(apps);
  const ownerTargetsByOrigin = new Map(
    fixture.ownerTargets.map((target) => [new URL(target.baseUrl).origin, target]),
  );

  const recorders = {
    apiBindingRequests: [],
    fragmentBindingRequests: [],
    outboundRequests: [],
  };
  const failedServices = new Set();
  const composition = {};
  const run = async (targetServers) => {
    const workerConfigurations = apps.map((app) =>
      createWorkerOptions(app, artifactRoot, {
        serviceBindings: createServiceBindings(app, { ...recorders, composition, failedServices }),
        // The network stays disabled except for the fixture's approved HTTPS
        // owner origins, which are served by the owner's own Worker.
        async outboundService(request) {
          const requestUrl = new URL(request.url);
          const outboundRequest = {
            callerId: app.id,
            method: request.method,
            requestBody: {
              contentLength: request.headers.get("content-length"),
              contentType: request.headers.get("content-type"),
              present: request.body !== null,
            },
            url: requestUrl.href,
          };
          recorders.outboundRequests.push(outboundRequest);
          const target = ownerTargetsByOrigin.get(requestUrl.origin);
          const owner = apps.find((candidate) => candidate.id === target?.appId);
          if (owner === undefined || failedServices.has(workerName(owner))) {
            return new Response("External network disabled by SSR proof", {
              status: 502,
            });
          }
          outboundRequest.targetAppId = owner.id;
          const response = await (
            await composition.miniflare.getWorker(workerName(owner))
          ).fetch(request);
          outboundRequest.response = {
            contentType: response.headers.get("content-type"),
            status: response.status,
          };
          return response;
        },
      }),
    );
    const executions = workerConfigurations.map((configuration) => configuration.executionEvidence);
    const executionByAppId = new Map(apps.map((app, index) => [app.id, executions[index]]));
    const workers = workerConfigurations.map(
      ({ executionEvidence: _executionEvidence, ...configuration }) => configuration,
    );
    const log = new ProofLog();
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        log,
        workers,
      }),
    );
    composition.miniflare = miniflare;
    const report = { executions, apiProofs: [], proofs: [], verticalProofs: [] };

    try {
      await seedWorkerdProofKv(miniflare, apps, apps, fixture);
      for (const shell of shells) {
        // Shell routes compose declared server-rendered boundaries through the
        // shell's entry Worker exactly as a browser request would.
        const renderedRemoteIds = new Set();
        for (const route of shell.ssrRoutes) {
          const proof = await proveRoute(
            shell,
            route,
            (url, init) => miniflare.dispatchFetch(url, init),
            apps,
            recorders,
            log,
          );
          assert(
            shell.serverRenderedRoutes.length > 0 || proof.boundaries.length === 0,
            `${shell.id} declares client composition but rendered distributed SSR boundaries for ${route}`,
          );
          if (shell.serverRenderedRoutes.includes(route)) {
            assert(
              shell.serverRenderedRemoteIds.length === 0 || proof.boundaries.length > 0,
              `${shell.id} rendered no distributed SSR boundaries for ${route}`,
            );
            for (const boundary of proof.boundaries) {
              renderedRemoteIds.add(boundary.remote);
            }
          }
          report.proofs.push({ shellId: shell.id, ...proof });
        }
        for (const remoteId of shell.serverRenderedRemoteIds) {
          assert(
            renderedRemoteIds.has(remoteId),
            `${shell.id} proof routes are missing independently rendered ${remoteId} content`,
          );
        }
        report.apiProofs.push(
          ...(await runApiProofs(apps, miniflare, shell, executionByAppId, fixture, recorders)),
        );
      }

      // Every UI MicroVertical proves its own Worker at its declared SSR routes,
      // whether or not a shell also composes it on the server.
      for (const [index, vertical] of apps.entries()) {
        if (vertical.kind !== "vertical" || vertical.ssrRoutes.length === 0) {
          continue;
        }
        const runtimeLog = new ProofLog();
        const runtime = await createIsolatedRuntime(
          workers[index],
          runtimeLog,
          vertical,
          apps,
          fixture,
        );
        try {
          for (const route of vertical.ssrRoutes) {
            report.verticalProofs.push({
              appId: vertical.id,
              ...(await proveRoute(
                vertical,
                route,
                (url, init) => runtime.dispatchFetch(url, init),
                apps,
                recorders,
                runtimeLog,
              )),
            });
          }
        } finally {
          await runtime.dispose();
        }
      }

      writeReport(reportPath, report);
      if (keepWorkerd) {
        await targetServers.start(
          miniflare,
          failedServices,
          workers,
          fixture,
        );
        console.log(`WORKERD_TARGET_URLS=${JSON.stringify(targetServers.targetUrls)}`);
        console.log(`WORKERD_URL=${targetServers.targetUrls[shells[0].id]}`);
        await new Promise((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
      }
    } finally {
      await targetServers?.stop();
      await miniflare.dispose();
    }

    console.log(`Workerd SSR composition proof passed for ${shells.length} shell(s): ${reportPath}`);
  };
  if (keepWorkerd) {
    await withWorkerdTargetServers(apps, run);
  } else {
    await run();
  }
};

if (import.meta.main) {
  await main();
}
