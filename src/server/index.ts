/**
 * Сервер: шифрование, вход и передача файлов.
 *
 * Интерфейс знает только это:
 *   import { VaultPanel } from './server'
 *
 * Внутри:
 *   - `crypto` — ключ из пароля и контейнер файла;
 *   - `vault`  — вход: соль, проверка пароля, ключ в памяти вкладки;
 *   - `files`  — загрузка частями с докачкой;
 *   - `VaultPanel` — экран входа.
 */

export { default as VaultPanel } from './VaultPanel.svelte'
export {
  VAULT_KEYS,
  createVault,
  currentKey,
  forgetVault,
  hasVault,
  lockVault,
  unlockVault,
  vaultState,
} from './vault'
export type { VaultState } from './vault'
