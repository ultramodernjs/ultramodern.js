# `@modern-js/app-tools-extensions`

Fork-owned UltraModern.js app tooling for Cloudflare Worker delivery, output verification, and release-envelope identity enforcement.

The package is composed into upstream app-tools through existing deploy/plugin extension seams. It must not depend on `@modern-js/app-tools`.

## Compiler platforms

UltraModern's bundled compiler supports macOS on Apple Silicon **M3 or newer**,
Linux x64/arm64 with glibc, and Windows x64. Intel Macs and x64 Node under Rosetta
are unsupported and fail before compiler selection; there is no Intel fallback.
Use native arm64 Node on a supported Mac.

The macOS release runner is checked for M3-or-newer hardware before building.
The arm64 payload is not a CPU-generation detector: M1/M2 machines are outside
the support policy, not claimed to be rejected by an instruction-set check.
Release compiler builds use Depot; Linux builds retain Ubuntu 22.04 so moving
runners does not raise their glibc baseline.

## Private origins and module-scope bindings

Private origins behind a Cloudflare Tunnel are first-class on
`deploy.worker.vpcServices` (`{ binding, serviceId, prefix? }`). Modern.js
writes them to `wrangler.json` as `vpc_services` (top level and every
`wrangler.env.<name>`, because Wrangler bindings are not inherited), and a
binding with `prefix`
is dispatched with `env[binding].fetch(request)` like a prefixed
`deploy.worker.services` entry. A VPC binding name may not reuse any other
Worker binding: any `binding` field or array-entry `name` in the Wrangler
config (`ASSETS`, services, D1, KV, Hyperdrive, queue producers, Durable
Objects, `send_email`, rate limits, …), including each `wrangler.env.<name>`'s
own bindings, or a `vars` key. A VPC prefix must be a decoded path starting with `/` that URL parsing keeps unchanged (no query, fragment,
`.` or `..` segments), and may not overlap, even as a percent-encoded alias, the
Effect BFF prefix or any other routed prefix (the worker decodes the request
path, dispatches the BFF first, matches path segments and takes the first
match),
and the typed option excludes a raw `wrangler.vpc_services`.

Code that needs a binding outside the request handler, such as a Hyperdrive
connection string or a VPC fetcher, imports `env` from `cloudflare:workers`,
which worker bundles externalize like `cloudflare:sockets`.
