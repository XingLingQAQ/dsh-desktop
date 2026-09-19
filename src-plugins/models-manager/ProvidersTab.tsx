/**
 * 渠道 — DSH's own Models provider page, vendored and rendered by this desktop.
 *
 * This is not a reimplementation. The component in `native/` IS the page the
 * platform ships, copied from `ui-settings-models` and given the same store,
 * schema service and copy dictionary it normally receives from the client
 * runtime. Re-drawing the page from its stylesheet, and then from its filter
 * expressions, both got details wrong that only the real component gets right:
 * the add flow, the setup card, the editor, and the model-list editor.
 *
 * What is *not* reused is how the platform wires it up. The native plugin
 * registers `settings.section id='models'` and renders its own child slots
 * (`settings.models.provider-card`, `settings.models.footer`). We shadow that
 * entry so our tab strip can own the page, and a shadowing registration is
 * rendered while declaring no children — so the seat the native component
 * expects does not exist, and calling it threw `renderSlot is not a function`
 * and took the whole tab slot down with it. Rendering the component directly,
 * outside the slot machinery, means there is no seat to lose.
 *
 * The data face is this desktop's own host route rather than the client
 * `connection` service, because that service has no `api` member in the build
 * that ships (see `provider-api.ts`).
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ModelsSection } from './native/ModelsSection.tsx'
import { ModelsSettingsStore } from './native/store.ts'
import { createSettingsSchemaOperations } from './native/schema-operations.ts'
import { SettingsSchemaService } from './native/settings-schema.ts'
import { zh } from './native/locales.ts'
import { createProviderApi, createDescribeFace } from './provider-api.ts'
import modelsStyles from './native/ModelsSection.module.css?inline'
import onboardingStyles from './native/OnboardingModal.module.css?inline'
import welcomeStyles from './native/WelcomeNotice.module.css?inline'
import deepseekStyles from './native/DeepSeekOnboardingDialog.module.css?inline'

/**
 * Put the vendored stylesheets in the document.
 *
 * The native page styles itself with CSS modules, which a plugin bundle cannot
 * ship the usual way: a library build emits the stylesheet to a separate asset
 * file, and a plugin is a single script the DSH module system evaluates — there
 * is no `<link>` to add and no bundler runtime to inject one. So each
 * stylesheet is imported with `?inline`, which yields the *processed* text with
 * the same hashed class names the module import hands the components, and the
 * text is written into one `<style>` tag.
 *
 * The tag is created once and tagged with this plugin, following the same rule
 * the rest of this plugin's styles follow: DSH claims untagged `<style>` tags
 * for whichever plugin is materializing, so a tag created later would be
 * attributed elsewhere and removed when that plugin reloads.
 */
const NATIVE_STYLE_ID = 'dsh-desktop-models-manager-native-styles'

if (document.getElementById(NATIVE_STYLE_ID) === null) {
  const el = document.createElement('style')
  el.id = NATIVE_STYLE_ID
  el.setAttribute('data-plugin', '@dsh-desktop/models-manager')
  el.textContent = [modelsStyles, onboardingStyles, welcomeStyles, deepseekStyles].join('\n')
  document.head.append(el)
}

/**
 * The 渠道 tab body.
 *
 * The store, schema service and describe face are constructed once and kept for
 * the life of the tab: they hold the page's loaded rows and its expected
 * settings revision, so rebuilding them per render would both re-fetch in a
 * loop and discard the state the page keeps across a write.
 * @returns the native Models page.
 */
export function ProvidersTab(): ReactNode {
  const services = useMemo(() => {
    const api = createProviderApi()
    return {
      api,
      describe: createDescribeFace(),
      operations: createSettingsSchemaOperations(new SettingsSchemaService()),
    }
  }, [])
  const store = useMemo(
    () => new ModelsSettingsStore(services.api, services.operations, services.describe),
    [services],
  )

  // The page loads on mount. Nothing else drives it, because here it is a tab
  // body rather than a section the settings shell mounts and unmounts — and the
  // tab stays mounted while hidden, so this runs exactly once.
  const loaded = useRef(false)
  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void store.load()
  }, [store])

  // Copy: the page asks for keys off its own dictionary, which the shipped
  // plugin registers through `ctx.locale`. Rendered directly there is no locale
  // seat, so the dictionary is resolved here — Chinese only, because that is
  // the language this desktop's settings interface is written in.
  const t = (key: keyof typeof zh): string => zh[key] ?? String(key)

  // The snapshot hook the renderer normally synthesizes: the store is a bare
  // observable (getSnapshot/subscribe), so React's own external-store hook is
  // the whole bridge. Building it inline would re-subscribe on every render,
  // which is why it is a stable callback.
  const subscribe = useCallback(
    (onChange: () => void) => store.store.subscribe(onChange),
    [store],
  )
  const getSnapshot = useCallback(() => store.store.getSnapshot(), [store])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  return (
    <ModelsSection
      controller={store}
      useSnapshot={() => snapshot}
      api={services.api}
      schema={services.operations}
      t={t}
    />
  )
}
