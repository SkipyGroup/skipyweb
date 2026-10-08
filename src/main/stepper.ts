import { app, shell, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type StepperConfig = {
  mode: 'main' | 'all'
  minSize: number
  stepMethod: 'auto' | 'key' | 'custom'
  customSelector?: string
  delayMs: number
  maxPages: number
  folderName?: string
  targetDirectory?: string
}

export type StepperState = {
  running: boolean
  paused: boolean
  currentPage: number
  downloadedCount: number
  targetFolder: string
  statusText: string
  lastDownloadedFile: string
  config: StepperConfig
}

type TabTarget = {
  id: string
  url: string
  contents: WebContents
}

const DEFAULT_CONFIG: StepperConfig = {
  mode: 'main',
  minSize: 150,
  stepMethod: 'auto',
  customSelector: '',
  delayMs: 2000,
  maxPages: 50,
  folderName: '',
}

export class ImageStepperService {
  private running = false
  private paused = false
  private currentPage = 0
  private downloadedCount = 0
  private targetFolder = ''
  private statusText = 'Készen áll'
  private lastDownloadedFile = ''
  private config: StepperConfig = { ...DEFAULT_CONFIG }
  private activeTarget: TabTarget | null = null
  private downloadedUrls = new Set<string>()
  private loopTimer: NodeJS.Timeout | null = null
  private abortController: AbortController | null = null

  constructor(
    private readonly onChange: () => void,
    private readonly onImageDownloaded?: (filename: string, fullPath: string, url: string) => void
  ) {}

  getState(): StepperState {
    return {
      running: this.running,
      paused: this.paused,
      currentPage: this.currentPage,
      downloadedCount: this.downloadedCount,
      targetFolder: this.targetFolder || this.config.targetDirectory || app.getPath('downloads'),
      statusText: this.statusText,
      lastDownloadedFile: this.lastDownloadedFile,
      config: { ...this.config },
    }
  }

  updateConfig(patch: Partial<StepperConfig>) {
    this.config = { ...this.config, ...patch }
    this.onChange()
  }

  setTargetDirectory(directory: string) {
    if (this.running) return
    this.targetFolder = directory
    this.updateConfig({ targetDirectory: directory })
  }

  async start(target: TabTarget, customConfig?: Partial<StepperConfig>) {
    if (this.running) this.stop()

    if (customConfig) {
      this.config = { ...this.config, ...customConfig }
    }

    this.activeTarget = target
    this.running = true
    this.paused = false
    this.currentPage = 0
    this.downloadedCount = 0
    this.downloadedUrls.clear()
    this.lastDownloadedFile = ''
    this.statusText = 'Indítás...'

    const folderName = this.config.folderName?.trim()
    const directory = this.config.targetDirectory || app.getPath('downloads')
    this.targetFolder = folderName
      ? path.join(directory, path.basename(folderName))
      : directory

    try {
      await fs.promises.mkdir(this.targetFolder, { recursive: true })
      await fs.promises.access(this.targetFolder, fs.constants.W_OK)
    } catch (err) {
      this.statusText = 'Nem sikerült létrehozni a célmappát'
      this.running = false
      this.onChange()
      return
    }

    this.statusText = 'Futás...'
    this.onChange()

    void this.stepLoop()
  }

  pause() {
    if (!this.running || this.paused) return
    this.paused = true
    this.statusText = 'Szüneteltetve'
    if (this.loopTimer) {
      clearTimeout(this.loopTimer)
      this.loopTimer = null
    }
    this.onChange()
  }

  resume() {
    if (!this.running || !this.paused) return
    this.paused = false
    this.statusText = 'Folytatás...'
    this.onChange()
    void this.stepLoop()
  }

  stop(status = 'Leállítva') {
    this.running = false
    this.paused = false
    this.statusText = status
    if (this.loopTimer) {
      clearTimeout(this.loopTimer)
      this.loopTimer = null
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    this.activeTarget = null
    this.onChange()
  }

  revealFolder() {
    if (this.targetFolder && fs.existsSync(this.targetFolder)) {
      shell.openPath(this.targetFolder).catch(() => undefined)
    } else {
      shell.openPath(app.getPath('downloads')).catch(() => undefined)
    }
  }

  private async stepLoop() {
    while (this.running && !this.paused) {
      if (!this.activeTarget || this.activeTarget.contents.isDestroyed()) {
        this.stop('A lap bezárult')
        break
      }

      this.currentPage++
      if (this.config.maxPages > 0 && this.currentPage > this.config.maxPages) {
        this.stop(`Elérte a ${this.config.maxPages} lapos korlátot`)
        break
      }

      this.statusText = `${this.currentPage}. lap feldolgozása...`
      this.onChange()

      // 1. Wait a bit for page images to load
      await this.sleep(600)
      if (!this.running || this.paused) break

      // 2. Extract image URLs from current DOM
      let imageUrls: string[] = []
      try {
        imageUrls = await this.extractImagesFromPage()
      } catch (err) {
        this.stop(`Nem sikerült lekérni a képeket: ${err instanceof Error ? err.message : String(err)}`)
        break
      }

      // Filter out already downloaded URLs
      const newUrls = imageUrls.filter(url => !this.downloadedUrls.has(url))

      // 3. Download the images for this page
      if (newUrls.length > 0) {
        this.statusText = `${this.currentPage}. lap: ${newUrls.length} kép letöltése...`
        this.onChange()

        for (const url of newUrls) {
          if (!this.running || this.paused) break
          const success = await this.downloadImage(url)
          if (success) {
            this.downloadedUrls.add(url)
            this.downloadedCount++
            this.onChange()
          } else if (this.running) {
            this.stop(this.statusText)
            break
          }
        }
      }

      if (!this.running || this.paused) break

      // 4. Trigger the NEXT step
      this.statusText = `${this.currentPage}. lap: Továbblépés keresése...`
      this.onChange()

      let nextResult = { ok: false, method: 'none' }
      try {
        nextResult = await this.triggerNextAction()
      } catch {
        nextResult = { ok: false, method: 'error' }
      }

      if (!nextResult.ok) {
        this.stop(`Befejezve: Nincs több továbblépési lehetőség (${this.downloadedCount} kép letöltve)`)
        break
      }

      // 5. Wait for page transition / delay
      this.statusText = `Várakozás a következő lapra (${Math.round(this.config.delayMs / 1000)}s)...`
      this.onChange()

      await this.sleep(Math.max(1000, this.config.delayMs))
    }
  }

  private async extractImagesFromPage(): Promise<string[]> {
    if (!this.activeTarget || this.activeTarget.contents.isDestroyed()) return []

    const script = `
      (() => {
        try {
          const mode = ${JSON.stringify(this.config.mode)};
          const minSize = ${Number(this.config.minSize) || 150};
          const candidates = [];

          const imgs = Array.from(document.querySelectorAll('img, picture source'));
          for (const el of imgs) {
            let src = '';
            let w = 0;
            let h = 0;
            if (el.tagName === 'IMG') {
              src = el.dataset.original || el.dataset.src || el.dataset.full || el.dataset.lazy || el.currentSrc || el.src;
              w = el.naturalWidth || el.clientWidth || 0;
              h = el.naturalHeight || el.clientHeight || 0;
            } else if (el.tagName === 'SOURCE') {
              src = el.srcset ? el.srcset.split(',')[0].trim().split(' ')[0] : '';
              w = 500;
              h = 500;
            }
            try { if (src) src = new URL(src, document.baseURI).href; } catch { src = ''; }
            if (src && /^https?:\\/\\//i.test(src)) {
              if (w >= minSize && h >= minSize) {
                candidates.push({ url: src, area: w * h });
              }
            }
          }

          // Also check links pointing directly to images
          const links = Array.from(document.querySelectorAll('a[href]'));
          for (const a of links) {
            if (/\\.(jpe?g|png|webp|avif|gif)(\\?.*)?$/i.test(a.href) && /^https?:\\/\\//i.test(a.href)) {
              candidates.push({ url: a.href, area: 400000 });
            }
          }

          // Deduplicate
          const uniqueMap = new Map();
          for (const c of candidates) {
            if (!uniqueMap.has(c.url)) uniqueMap.set(c.url, c);
          }
          const unique = Array.from(uniqueMap.values());

          if (mode === 'main') {
            unique.sort((a, b) => b.area - a.area);
            return unique.slice(0, 1).map(c => c.url);
          }
          return unique.map(c => c.url);
        } catch {
          return [];
        }
      })()
    `

    const result = await this.activeTarget.contents.executeJavaScript(script, true)
    return Array.isArray(result) ? result : []
  }

  private async triggerNextAction(): Promise<{ ok: boolean; method: string }> {
    if (!this.activeTarget || this.activeTarget.contents.isDestroyed()) return { ok: false, method: 'none' }

    const method = this.config.stepMethod
    const customSelector = this.config.customSelector || ''

    const script = `
      (() => {
        try {
          const method = ${JSON.stringify(method)};
          const customSel = ${JSON.stringify(customSelector)};

          if (method === 'key') {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true }));
            window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true }));
            return { ok: true, method: 'key' };
          }

          if (method === 'custom' && customSel) {
            const el = document.querySelector(customSel);
            if (el) {
              el.click();
              return { ok: true, method: 'custom' };
            }
          }

          // Auto-detection strategy:
          // 1. rel="next"
          const relNext = document.querySelector('a[rel="next"], link[rel="next"]');
          if (relNext && relNext instanceof HTMLAnchorElement && relNext.href) {
            relNext.click();
            return { ok: true, method: 'rel-next' };
          }

          // 2. Standard next selectors
          const nextSelectors = [
            '.next', '#next', '.next-page', '#next-page', '.btn-next', '.pagination-next',
            'a.next', 'a.next-page', 'button.next', '.nav-next a', '.pager-next a',
            '[aria-label*="next" i]', '[aria-label*="következő" i]',
            '[title*="next" i]', '[title*="következő" i]'
          ];
          for (const sel of nextSelectors) {
            const el = document.querySelector(sel);
            if (el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)) {
              el.click();
              return { ok: true, method: 'selector: ' + sel };
            }
          }

          // 3. Text content scanning
          const clickable = Array.from(document.querySelectorAll('a, button, [role="button"]'));
          const nextKeywords = [
            /^\\s*(next|következő|tovább|előre|»|>|›)\\s*$/i,
            /next\\s*(page|image|›|»)?/i,
            /következő\\s*(lap|oldal|kép)?/i
          ];
          for (const el of clickable) {
            const text = (el.textContent || '').trim();
            if (nextKeywords.some(pattern => pattern.test(text))) {
              if (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0) {
                el.click();
                return { ok: true, method: 'text: ' + text };
              }
            }
          }

          // 4. Fallback to right arrow key
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true }));
          return { ok: true, method: 'key-fallback' };
        } catch (e) {
          return { ok: false, method: 'error' };
        }
      })()
    `

    const res = await this.activeTarget.contents.executeJavaScript(script, true)
    return res && typeof res === 'object' && res.ok ? res : { ok: false, method: 'not-found' }
  }

  private async downloadImage(url: string): Promise<boolean> {
    try {
      const target = this.activeTarget
      if (!target || target.contents.isDestroyed()) throw new Error('A lap nem elérhető')
      this.abortController = new AbortController()
      const response = await target.contents.session.fetch(url, {
        signal: this.abortController.signal,
        headers: {
          Referer: target.contents.getURL() || target.url,
          'User-Agent': target.contents.getUserAgent(),
        },
      })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const contentType = (response.headers.get('content-type') || '').toLowerCase()
      if (contentType && !contentType.startsWith('image/') && !contentType.startsWith('application/octet-stream')) {
        throw new Error('A kiszolgáló nem képet küldött')
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      if (!buffer.length) throw new Error('Üres képfájl')
      if (!this.running || this.activeTarget !== target) return false

      // Determine extension
      let ext = path.extname(new URL(url).pathname).toLowerCase()
      if (!ext || ext.length > 5 || !['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'].includes(ext)) {
        const contentType = response.headers.get('content-type') || ''
        if (contentType.includes('webp')) ext = '.webp'
        else if (contentType.includes('png')) ext = '.png'
        else if (contentType.includes('gif')) ext = '.gif'
        else if (contentType.includes('avif')) ext = '.avif'
        else ext = '.jpg'
      }

      const paddedIndex = String(this.downloadedCount + 1).padStart(4, '0')
      let rawName = path.basename(new URL(url).pathname, ext).slice(0, 30) || 'kep'
      rawName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_')
      let filename = `${paddedIndex}_${rawName}${ext}`
      let fullPath = path.join(this.targetFolder, filename)

      for (let suffix = 1; ; suffix++) {
        try {
          await fs.promises.writeFile(fullPath, buffer, { flag: 'wx' })
          break
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          filename = `${paddedIndex}_${rawName}_${suffix}${ext}`
          fullPath = path.join(this.targetFolder, filename)
        }
      }
      this.lastDownloadedFile = filename

      this.onImageDownloaded?.(filename, fullPath, url)
      return true
    } catch (err) {
      if (this.running) {
        this.statusText = `Képletöltési hiba: ${err instanceof Error ? err.message : String(err)}`
        this.onChange()
      }
      return false
    } finally {
      this.abortController = null
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.loopTimer = setTimeout(resolve, ms)
    })
  }
}
