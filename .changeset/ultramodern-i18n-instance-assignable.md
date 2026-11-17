---
'@modern-js/plugin-i18n': major
---

fix(plugin-i18n): make `I18nInstance` assignable from an i18next instance

The documented and most common usage, `runtime: { i18n: { i18nInstance: i18next } }`,
did not typecheck: `Type 'i18n' is not assignable to type 'I18nInstance'`. The cause
was the interface's top-level `[key: string]: unknown` — TypeScript never grants an
interface an implicit index signature — plus overloaded call-signature properties,
whose bivariance turned out to be order-dependent across program compositions.

`I18nInstance` now declares the i18next members it needs explicitly (`t`, `exists`,
`getFixedT`, `hasLoadedNamespace`, `dir`, `format`, `languages`, `resolvedLanguage`,
`loadNamespaces`, `loadLanguages`, `addResourceBundle`, `getResourceBundle`,
`getDataByLanguage`), uses single non-overloaded method signatures, and is re-exported
from `@modern-js/plugin-i18n/runtime` alongside `TranslateFn` and
`UseModernI18nReturn`. `useModernI18n` has an overload with a type argument
(`useModernI18n<MyInstance>() where MyInstance extends I18nRuntimeInstance`) that
types the returned `i18nInstance` and `t`; it is a caller assertion, not a runtime
check.

`t` and `getFixedT` are i18next's own types: `TranslateFn` is `i18n['t']` and
`getFixedT` is `i18n['getFixedT']`. A hand-written translate signature drifts with
every i18next release (i18next 27 replaced the `t` overloads with a rest-tuple union,
which made `i18nInstance: i18next` fail again) and rejects applications that enable
strict keys or selectors. Keys, overloads, selectors and `CustomTypeOptions`
augmentation now apply to `i18nInstance.t` and to the `t` returned by
`useModernI18n()`.

Custom wrappers that own a native i18next instance at `i18nInstance.instance` are
modelled separately as `I18nWrapperInstance`, with their own `t(key: string)`, and
`I18nRuntimeInstance = I18nInstance | I18nWrapperInstance` is what the runtime config,
plugin options and runtime context accept. The plugin still initialises, switches and
clones the wrapper itself, so the wrapper's own initialisation keeps controlling its
`t`; resources, detection and the react-i18next provider use the native instance.
`useModernI18n().t` is the configured instance's own `t` bound to it, so a wrapper's
translate API and its receiver keep producing the output.
`I18nInstance` gains `on`/`off` typed from i18next's event API.

BREAKING: `t` is now a REQUIRED member of `I18nInstance`, typed as i18next's
`i18n['t']`. Upstream declared no `t` at all. Code that produces an `I18nInstance`
from an object literal (custom instances, test doubles) must now carry a genuine
i18next `t`, for example from `i18next.createInstance()`; a hand-written translate
function is rejected. Real i18next instances are unaffected.

BREAKING: `useModernI18n().t` and `.i18nInstance` are typed from the configured
instance instead of `(key: string | string[], ...args: any[]) => string` and
`I18nInstance`. Without a type argument they are typed for an i18next instance, so
`t('key', { count })`, default values, key arrays and selectors keep i18next's own
types. An app that configures a wrapper names it, `useModernI18n<MyWrapper>()`, to
get the wrapper's `t` and members.

BREAKING: the provider no longer fabricates a placeholder instance. The runtime always
runs `onBeforeRender` (which resolves the instance) before rendering a root, including
a nested Module Federation app root. A root rendered outside that lifecycle still
renders, but without Modern i18n context, so `useModernI18n` throws
`useModernI18n must be used within ModernI18nProvider` instead of returning a
placeholder whose `t` threw `i18nInstance.t required` when called.

BREAKING: `I18nInstance` no longer declares `[key: string]: unknown`. Reading a
property that is not declared on the interface is now a type error (TS2339); cast to
the concrete instance type instead. `services.languageDetector`, `options.detection`
and `options.backend` are now `any`, so `src/runtime/i18n/utils.ts` and
`backend/middleware.common.ts` read and write through `options.backend` unchecked, and
`init`/`createInstance`/`cloneInstance` take `any` options instead of
`I18nInitOptions`. These are accepted costs of assignability.
