<script lang="ts">
  /**
   * Вход: пароль, которым шифруются файлы перед отправкой на сервер.
   *
   * Три состояния, и каждое говорит человеку правду:
   *   - не настроен — предлагаем придумать пароль и честно предупреждаем,
   *     что забыть его нельзя;
   *   - закрыт — просим пароль, проверяем по сохранённой проверке;
   *   - открыт — говорим, что ключ живёт только в этой вкладке, и даём
   *     закрыть или забыть.
   *
   * Пароль не сохраняется и никуда не отправляется: на сервер уходят только
   * зашифрованные файлы.
   */

  import { onMount } from 'svelte'
  import {
    createVault,
    forgetVault,
    lockVault,
    unlockVault,
    vaultState,
    createRecovery,
    formatRecovery,
    hasRecovery,
    unlockWithRecovery,
    type VaultState,
  } from './vault'
  import { readServerConfig, writeServerConfig } from './offload'
  import { readAutoBackupState, restoreAutoBackup, runAutoBackup } from '../backup/auto'
  import { describeImport } from '../data'

  let { onRestored }: { onRestored?: () => void } = $props()

  /** Минимальная длина: короткий пароль подбирается слишком быстро. */
  const MIN_LENGTH = 8

  let mode = $state<VaultState>('none')
  let passphrase = $state('')
  let busy = $state(false)
  let status = $state<string | null>(null)
  let failed = $state(false)
  /** «Забыть пароль» спрашивает подтверждение: действие необратимо. */
  let confirmForget = $state(false)
  /** Пароль сервера (`MUZA_TOKEN`). Без него файлы остаются на телефоне. */
  let serverToken = $state('')
  let serverBusy = $state(false)
  let serverNote = $state<string | null>(null)
  /** Копия на сервере: дата и восстановление. */
  let backupAt = $state<string | null>(null)
  let restoreBusy = $state(false)
  let confirmRestore = $state(false)
  let restoreNote = $state<string | null>(null)
  let restoreFailed = $state(false)

  /** Код восстановления: показывается один раз после создания. */
  let recoveryCode = $state<string | null>(null)
  let recoverySaved = $state(false)
  let recoveryCopied = $state(false)
  let recoveryNote = $state<string | null>(null)
  let hasCode = $state(false)
  /** Вход по коду вместо пароля. */
  let useRecovery = $state(false)
  let recoveryInput = $state('')

  onMount(() => {
    void refresh()
  })

  async function refresh(): Promise<void> {
    try {
      mode = await vaultState()
      serverToken = (await readServerConfig()).token
      backupAt = (await readAutoBackupState()).lastAt
      hasCode = await hasRecovery()
      // Ключ уже в памяти (вкладку не закрывали) — копию можно сделать.
      if (mode === 'unlocked') void runAutoBackup().catch(() => {})
    } catch (e) {
      failed = true
      status = `Хранилище недоступно: ${describe(e)}`
    }
  }

  function describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  /** Первый вход: создаём соль и проверку. */
  async function create(): Promise<void> {
    if (busy) return
    if (passphrase.trim().length < MIN_LENGTH) {
      failed = true
      status = `Пароль короче ${MIN_LENGTH} символов — такой подбирается слишком быстро.`
      return
    }
    busy = true
    failed = false
    status = null
    try {
      await createVault(passphrase)
      passphrase = ''
      await refresh()
      // Код предлагаем сразу: потом человек о нём забудет.
      void startRecovery()
      void runAutoBackup().catch(() => {})
      status = 'Шифрование включено. Пароль нигде не сохранён — запомните его.'
    } catch (e) {
      failed = true
      status = describe(e)
    } finally {
      busy = false
    }
  }

  /** Вход по паролю. */
  async function unlock(): Promise<void> {
    if (busy || passphrase === '') return
    busy = true
    failed = false
    status = null
    try {
      const ok = await unlockVault(passphrase)
      passphrase = ''
      await refresh()
      if (ok) {
        status = 'Открыто. Ключ живёт только в этой вкладке.'
        void runAutoBackup().catch(() => {})
      }
      else {
        failed = true
        status = 'Пароль не подходит. Проверьте раскладку и регистр.'
      }
    } catch (e) {
      failed = true
      status = describe(e)
    } finally {
      busy = false
    }
  }

  /** Сохранить пароль сервера. Пустой — значит «не отправлять файлы». */
  async function saveServerToken(): Promise<void> {
    if (serverBusy) return
    serverBusy = true
    try {
      const config = await writeServerConfig({ token: serverToken })
      serverToken = config.token
      serverNote = config.token === ''
        ? 'Пароль не задан: файлы остаются на телефоне.'
        : 'Пароль сохранён в этом браузере.'
      failed = false
      // Появился сервер — первая копия не ждёт суток.
      if (config.token !== '') void runAutoBackup().catch(() => {})
    } catch (e) {
      failed = true
      serverNote = `Не удалось сохранить: ${describe(e)}`
    } finally {
      serverBusy = false
    }
  }

  /** Создать код восстановления для открытого входа. */
  async function startRecovery(): Promise<void> {
    recoveryNote = null
    try {
      recoveryCode = await createRecovery()
      recoverySaved = false
      recoveryCopied = false
      hasCode = true
    } catch (e) {
      recoveryNote = `Не удалось создать код: ${describe(e)}`
    }
  }

  /** Скопировать код в буфер: чаще всего его несут в менеджер паролей. */
  async function copyRecovery(): Promise<void> {
    if (!recoveryCode) return
    try {
      await navigator.clipboard.writeText(formatRecovery(recoveryCode))
      recoveryCopied = true
    } catch {
      recoveryNote = 'Скопировать не дали — запишите код вручную.'
    }
  }

  /** Вход по коду: ключ тот же, что от пароля. */
  async function unlockByCode(): Promise<void> {
    if (busy) return
    busy = true
    failed = false
    try {
      const ok = await unlockWithRecovery(recoveryInput)
      if (ok) {
        recoveryInput = ''
        useRecovery = false
        await refresh()
        status = 'Открыто по коду восстановления. Ключ живёт только в этой вкладке.'
        void runAutoBackup().catch(() => {})
      } else {
        failed = true
        status = 'Код не подошёл. Проверьте символы: O/0 и I/L/1 не различаются.'
      }
    } catch (e) {
      failed = true
      status = describe(e)
    } finally {
      busy = false
    }
  }

  /** Восстановить идеи из последней автокопии (импорт умеет вливать). */
  async function restore(): Promise<void> {
    if (restoreBusy) return
    if (!confirmRestore) {
      confirmRestore = true
      restoreNote = 'Нажмите ещё раз: копия вольётся в текущие идеи, ничего не затирая.'
      return
    }
    confirmRestore = false
    restoreBusy = true
    restoreFailed = false
    try {
      const result = await restoreAutoBackup()
      if (result.ok && result.report) {
        restoreNote = `Восстановлено: ${describeImport(result.report)}`
        onRestored?.()
      } else {
        restoreFailed = true
        restoreNote = restoreReason(result.reason)
      }
    } catch (e) {
      restoreFailed = true
      restoreNote = `Не удалось: ${describe(e)}`
    } finally {
      restoreBusy = false
    }
  }

  function restoreReason(reason: string): string {
    if (reason === 'none') return 'Автоматической копии пока нет.'
    if (reason === 'locked') return 'Сначала откройте вход.'
    if (reason === 'no_token') return 'Не задан пароль сервера.'
    if (reason === 'decrypt') return 'Копия не расшифровалась: пароль другой или файл повреждён.'
    return 'Не удалось скачать копию.'
  }

  /** Закрыть: ключ стирается из памяти, файлы на сервере не трогаются. */
  function lock(): void {
    lockVault()
    void refresh()
    failed = false
    status = 'Закрыто. Файлы на сервере остались зашифрованными.'
  }

  /** Забыть пароль: необратимо, поэтому только после подтверждения. */
  async function forget(): Promise<void> {
    if (busy) return
    busy = true
    try {
      await forgetVault()
      confirmForget = false
      passphrase = ''
      await refresh()
      failed = false
      status = 'Вход сброшен. Старые файлы на сервере открыть уже не получится.'
    } catch (e) {
      failed = true
      status = describe(e)
    } finally {
      busy = false
    }
  }
</script>

<section class="vault">
  <h2>Сервер: шифрование файлов</h2>

  <p class="lead">
    Файлы шифруются на этом устройстве, и на сервер уходят уже нечитаемыми.
    Пароль не сохраняется и никуда не отправляется — он нужен, чтобы открыть
    файлы снова.
  </p>

  {#if recoveryCode}
    <!-- Код показывается ОДИН раз: второго шанса скопировать не будет. -->
    <div class="recovery">
      <h3>Код восстановления</h3>
      <p class="lead">
        Сохраните его в менеджере паролей (iCloud Keychain, Google Password
        Manager) или на бумаге. Без кода забытый пароль не вернуть.
      </p>
      <code class="recovery-code">{formatRecovery(recoveryCode)}</code>
      <div class="row">
        <button type="button" class="btn" onclick={() => void copyRecovery()}>
          {recoveryCopied ? 'Скопировано' : 'Скопировать'}
        </button>
      </div>
      <label class="recovery-check">
        <input type="checkbox" bind:checked={recoverySaved} />
        Я сохранил код в надёжном месте
      </label>
      <div class="row">
        <button
          type="button"
          class="btn"
          disabled={!recoverySaved}
          onclick={() => (recoveryCode = null)}
        >
          Готово
        </button>
      </div>
      {#if recoveryNote}
        <p class="status" class:failed>{recoveryNote}</p>
      {/if}
    </div>
  {/if}

  {#if mode === 'none'}
    <p class="warn">
      Пароль нельзя восстановить. Если забыть его, файлы на сервере останутся
      зашифрованными навсегда.
    </p>
    <label class="field">
      <span>Пароль</span>
      <input
        type="password"
        aria-label="Пароль шифрования"
        autocomplete="new-password"
        placeholder="Не короче {MIN_LENGTH} символов"
        bind:value={passphrase}
        disabled={busy}
      />
    </label>
    <div class="row">
      <button type="button" class="btn" onclick={() => void create()} disabled={busy}>
        {busy ? 'Включаю…' : 'Включить шифрование'}
      </button>
    </div>
  {:else if mode === 'locked'}
    {#if useRecovery}
      <label class="field">
        <span>Код восстановления</span>
        <input
          type="text"
          aria-label="Код восстановления"
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          autocomplete="off"
          bind:value={recoveryInput}
          disabled={busy}
        />
      </label>
      <div class="row">
        <button type="button" class="btn" onclick={() => void unlockByCode()} disabled={busy}>
          {busy ? 'Проверяю…' : 'Войти по коду'}
        </button>
        <button type="button" class="link" onclick={() => (useRecovery = false)} disabled={busy}>
          Назад к паролю
        </button>
      </div>
    {:else}
    <label class="field">
      <span>Пароль</span>
      <input
        type="password"
        aria-label="Пароль шифрования"
        autocomplete="current-password"
        placeholder="Тот, что придумали"
        bind:value={passphrase}
        disabled={busy}
      />
    </label>
    <div class="row">
      <button type="button" class="btn" onclick={() => void unlock()} disabled={busy}>
        {busy ? 'Проверяю…' : 'Открыть'}
      </button>
      <button
        type="button"
        class="link"
        onclick={() => (confirmForget = !confirmForget)}
        disabled={busy}
      >
        Забыть пароль
      </button>
    </div>
    <div class="row">
      <button type="button" class="link" onclick={() => (useRecovery = true)} disabled={busy}>
        Забыли пароль? Войти по коду
      </button>
    </div>
    {/if}
  {:else}
    <p class="ok">Шифрование включено в этой вкладке.</p>
    {#if !hasCode && !recoveryCode}
      <p class="warn">
        Код восстановления не создан. Если забыть пароль, данные не вернуть —
        ни вам, ни нам.
      </p>
      <div class="row">
        <button type="button" class="btn" onclick={() => void startRecovery()} disabled={busy}>
          Создать код восстановления
        </button>
      </div>
    {:else if hasCode}
      <p class="hint">Код восстановления создан и хранится только у вас.</p>
    {/if}
    <div class="row">
      <button type="button" class="btn" onclick={lock} disabled={busy}>Закрыть</button>
      <button
        type="button"
        class="link"
        onclick={() => (confirmForget = !confirmForget)}
        disabled={busy}
      >
        Забыть пароль
      </button>
    </div>
  {/if}

  {#if confirmForget}
    <div class="confirm">
      <p>
        Сбросить вход? Старые файлы на сервере станут нечитаемыми — ключа
        от них не останется нигде.
      </p>
      <div class="row">
        <button type="button" class="danger" onclick={() => void forget()} disabled={busy}>
          Да, сбросить
        </button>
        <button type="button" class="link" onclick={() => (confirmForget = false)} disabled={busy}>
          Отмена
        </button>
      </div>
    </div>
  {/if}

  <!-- Пароль сервера — второй секрет, не связанный с ключом шифрования:
       ключ не уходит с устройства, а этот пароль нужен, чтобы сервер
       вообще принял файл. -->
  <div class="server">
    <h3>Пароль сервера</h3>
    <p class="lead">
      Нужен, чтобы отправлять файлы на сервер. Хранится в этом браузере.
      Пока он не задан, всё остаётся на телефоне.
    </p>
    <label class="field">
      <span>Пароль сервера</span>
      <input
        type="password"
        aria-label="Пароль сервера"
        autocomplete="off"
        placeholder="Тот, что задан в MUZA_TOKEN"
        bind:value={serverToken}
        disabled={serverBusy}
      />
    </label>
    <div class="row">
      <button type="button" class="btn" onclick={() => void saveServerToken()} disabled={serverBusy}>
        {serverBusy ? 'Сохраняю…' : 'Сохранить пароль сервера'}
      </button>
    </div>
    {#if serverNote}
      <p class="status" class:failed={false}>{serverNote}</p>
    {/if}
  </div>

  <!-- Восстановление из автокопии: копия уже уходит, но без этой кнопки
       вернуть её можно было бы только вручную, файлом. -->
  <div class="server">
    <h3>Копия на сервере</h3>
    <p class="lead">
      {backupAt
        ? `Последняя автоматическая копия: ${new Date(backupAt).toLocaleString('ru-RU')}`
        : 'Автоматической копии пока нет — она делается после включения входа и пароля сервера.'}
    </p>
    <div class="row">
      <button
        type="button"
        class="btn"
        onclick={() => void restore()}
        disabled={restoreBusy || !backupAt}
      >
        {restoreBusy
          ? 'Восстанавливаю…'
          : confirmRestore
            ? 'Точно восстановить?'
            : 'Восстановить из копии'}
      </button>
    </div>
    {#if restoreNote}
      <p class="status" class:failed={restoreFailed}>{restoreNote}</p>
    {/if}
  </div>

  {#if status}
    <p class:failed class="status">{status}</p>
  {/if}
</section>

<style>
  .recovery {
    margin: 14px 0;
    padding: 14px;
    border-radius: 12px;
    background: #111725;
    border: 1px solid #2b3a55;
  }

  .recovery h3 {
    margin: 0 0 8px;
    font-size: 15px;
  }

  .recovery-code {
    display: block;
    margin: 10px 0;
    padding: 12px;
    border-radius: 10px;
    background: #0a0f1a;
    color: #ffd9a8;
    font: 600 16px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 1px;
    word-break: break-all;
    user-select: all;
  }

  .recovery-check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0;
    font-size: 14px;
    color: #e7edf7;
    cursor: pointer;
  }

  .recovery-check input {
    width: 20px;
    height: 20px;
    accent-color: #ff8a5b;
  }

  .vault {
    margin-top: 18px;
  }

  h2 {
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 600;
  }

  .lead {
    margin: 0 0 10px;
    font-size: 13px;
    line-height: 1.45;
    color: #8b96ab;
  }

  .warn {
    margin: 0 0 12px;
    padding: 10px 12px;
    border-radius: 10px;
    background: #2a1d16;
    border: 1px solid #4a2f22;
    color: #e8b48f;
    font-size: 13px;
    line-height: 1.4;
  }

  .ok {
    margin: 0 0 10px;
    font-size: 13px;
    color: #7fd1a8;
  }

  .field {
    display: block;
    margin-bottom: 10px;
  }

  .field span {
    display: block;
    margin-bottom: 4px;
    font-size: 12px;
    color: var(--dim);
  }

  .field input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #232a3b;
    background: #0d1220;
    color: #e8ecf2;
    font: inherit;
    font-size: 15px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .btn {
    padding: 10px 14px;
    border-radius: 10px;
    border: 1px solid #232a3b;
    background: #111725;
    color: #e8ecf2;
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }

  .btn:hover:not(:disabled) {
    border-color: #ff8a5b;
    color: #ff8a5b;
  }

  .btn:disabled,
  .link:disabled,
  .danger:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .link {
    padding: 6px 2px;
    border: 0;
    background: none;
    color: #8b96ab;
    font: inherit;
    font-size: 13px;
    text-decoration: underline;
    cursor: pointer;
  }

  .confirm {
    margin-top: 12px;
    padding: 12px;
    border-radius: 10px;
    background: #1a1420;
    border: 1px solid #3a2a44;
  }

  .confirm p {
    margin: 0 0 10px;
    font-size: 13px;
    line-height: 1.4;
    color: #c9b6d6;
  }

  .danger {
    padding: 9px 14px;
    border-radius: 10px;
    border: 1px solid #5a2a2a;
    background: #2a1414;
    color: #f0a0a0;
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }

  .server {
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid #1d2433;
  }

  .server h3 {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 600;
  }

  .status {
    margin: 10px 0 0;
    font-size: 13px;
    line-height: 1.4;
    color: #7fd1a8;
  }

  .status.failed {
    color: #f0a0a0;
  }
</style>
