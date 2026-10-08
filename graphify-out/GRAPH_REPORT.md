# Graph Report - skipyweb  (2026-10-08)

## Corpus Check
- 45 files · ~110,515 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 6 file(s) not represented in the graph (top: .css 3, (none) 2, .ico 1)

## Summary
- 699 nodes · 1444 edges · 36 communities (32 shown, 4 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 39 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Developer Tools Storage
- Browser Main Renderer
- Package Dependencies
- Main Process Coordination
- Developer Tools Renderer
- Website Protection
- Test Run Controller
- Overlay Panels
- Developer Tools Service
- Installer Configuration
- Network Privacy Logging
- Library User Actions
- Library Persistence
- Developer Tools Smoke Tests
- Tab Lifecycle and Audio
- Updates and Fingerprint Protection
- Browser Product Features
- Private Session Smoke Tests
- Store Unit Tests
- API Unit Tests
- Image Stepper Service
- Main TypeScript Configuration
- Browser Keyboard Shortcuts
- Page Events and Certificates
- Browser Shell and Branding
- View Layout and Prompts
- Preload TypeScript Configuration
- Release Build Workflows
- Developer Tools Interface
- Renderer TypeScript Configuration
- Tab Navigation
- Page Automation Commands
- Overlay Dialog Interface
- Audio Renderer Bridge
- Address Suggestions Renderer

## God Nodes (most connected - your core abstractions)
1. `publish()` - 44 edges
2. `SdtController` - 38 edges
3. `attachPage()` - 28 edges
4. `SdtService` - 28 edges
5. `SdtStore` - 24 edges
6. `layout()` - 23 edges
7. `getLibrary()` - 22 edges
8. `handleShortcut()` - 19 edges
9. `Skipy Browser` - 19 edges
10. `notice()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Address combobox, security, bookmark and copy controls` --implements--> `Address bar URL navigation and search`  [INFERRED]
  src/renderer/index.html → README.md
- `Dedicated address suggestion listbox renderer` --implements--> `Floating address suggestions`  [INFERRED]
  src/renderer/suggestions.html → README.md
- `Download confirmation with custom location` --implements--> `Download confirmation and download management`  [INFERRED]
  src/renderer/index.html → README.md
- `Hidden audio module renderer` --conceptually_related_to--> `Bass Booster`  [INFERRED]
  src/renderer/audio.html → README.md
- `SDT developer tools renderer` --implements--> `Skipy Developer Tools`  [INFERRED]
  src/renderer/sdt.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Developer inspection and test suite** — src_renderer_sdt_sdt_panel, src_renderer_sdt_colors, src_renderer_sdt_api, src_renderer_sdt_tests [EXTRACTED 1.00]

## Communities (36 total, 4 thin omitted)

### Community 0 - "Developer Tools Storage"
Cohesion: 0.06
Nodes (38): electron, httpUrl(), METHODS, REDIRECT_STATUSES, requestApi(), TRANSPORT_HEADERS, validate(), Cancelled (+30 more)

### Community 1 - "Browser Main Renderer"
Cohesion: 0.07
Nodes (53): classifyInput(), resolveInput(), actionButton(), address, Bookmark, BrowserBridge, buildSuggestions(), CertificateState (+45 more)

### Community 2 - "Package Dependencies"
Cohesion: 0.06
Nodes (32): allowScripts, electron@44.4.3, dependencies, electron-updater, extract-zip, lucide, tldts, description (+24 more)

### Community 3 - "Main Process Coordination"
Cohesion: 0.06
Nodes (31): blockedAdsBySite, CertificateState, closedTabs, closeTimers, configurePlatformQuickActions(), connectivityCache, downloadsButton, downloadTabIds (+23 more)

### Community 4 - "Developer Tools Renderer"
Cohesion: 0.15
Nodes (32): addHeader(), addStep(), alterSteps(), Bridge, button(), command(), copy(), createStepElement() (+24 more)

### Community 5 - "Website Protection"
Cohesion: 0.10
Nodes (31): answerSwpPrompt(), monitorRequests(), pageSafety(), publicState(), publishSoon(), adblockEnabled(), bundledCosmetic, bundledHosts (+23 more)

### Community 7 - "Overlay Panels"
Cohesion: 0.15
Nodes (27): action(), answerDialog(), command(), Entry, favicon(), formatBytes(), mode, Privacy (+19 more)

### Community 9 - "Installer Configuration"
Cohesion: 0.08
Nodes (24): build, appId, asar, directories, files, mac, nsis, productName (+16 more)

### Community 10 - "Network Privacy Logging"
Cohesion: 0.15
Nodes (21): fingerprintSeed(), clearRequests(), data, flushPrivacy(), hostForUrl(), isBlocked(), isFingerprintEnabled(), loadPrivacy() (+13 more)

### Community 11 - "Library User Actions"
Cohesion: 0.17
Nodes (22): getLibrary(), id(), saveLibrary(), activateDownload(), chooseExtension(), chromeExtensionId(), configuredHome(), crxZipOffset() (+14 more)

### Community 12 - "Library Persistence"
Cohesion: 0.16
Nodes (19): Bookmark, defaultSettings, DownloadEntry, ExtensionEntry, flushLibrary(), HistoryEntry, Library, loadLibrary() (+11 more)

### Community 13 - "Developer Tools Smoke Tests"
Cohesion: 0.15
Nodes (18): { app, BrowserWindow, clipboard, webContents, session }, appData, assert, chrome(), dataDir, fs, http, os (+10 more)

### Community 14 - "Tab Lifecycle and Audio"
Cohesion: 0.17
Nodes (19): answerJsDialog(), clearSiteData(), closeTab(), ensureJsDialogView(), ensureSwpPromptView(), ensureToolView(), finishCloseTab(), hibernateTab() (+11 more)

### Community 15 - "Updates and Fingerprint Protection"
Cohesion: 0.12
Nodes (8): electron-updater, installFingerprint(), change(), copiedCanvas(), patchWebGL(), { contextBridge, ipcRenderer }, UpdateService, UpdateState

### Community 16 - "Browser Product Features"
Cohesion: 0.14
Nodes (10): Bookmarks, Electron browser architecture, Browser and video fullscreen, Browsing history, Network host blocking rules, Search provider and homepage settings, HTTPS certificate information, Skipy Browser (+2 more)

### Community 17 - "Private Session Smoke Tests"
Cohesion: 0.15
Nodes (13): { app, BrowserWindow, webContents }, assert, extensionPath, fs, http, os, path, pause() (+5 more)

### Community 18 - "Store Unit Tests"
Cohesion: 0.14
Nodes (6): assert, fs, os, path, { SdtStore, validateSteps }, { test }

### Community 19 - "API Unit Tests"
Cohesion: 0.15
Nodes (6): assert, { gzipSync }, http, input(), { requestApi }, { test }

### Community 21 - "Main TypeScript Configuration"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, module, moduleResolution, outDir, rootDir, skipLibCheck, strict (+4 more)

### Community 22 - "Browser Keyboard Shortcuts"
Cohesion: 0.29
Nodes (12): adjustZoom(), current(), cycleTabs(), handleShortcut(), resetZoom(), selectTabByIndex(), showTab(), startFind() (+4 more)

### Community 23 - "Page Events and Certificates"
Cohesion: 0.23
Nodes (12): attachPage(), certificateKey(), clearTransition(), closeSuggestions(), dataPage(), escapeHtml(), hasInternetAccess(), monitorCertificate() (+4 more)

### Community 24 - "Browser Shell and Branding"
Cohesion: 0.18
Nodes (11): Orange fox globe application icon, Orange fox encircling globe source logo, Address bar URL navigation and search, Orange glow and steel curves over dark wave layers, Address combobox, security, bookmark and copy controls, Browser shell and start page, Find in page controls, Start page with clock, greeting, search and quick links (+3 more)

### Community 25 - "View Layout and Prompts"
Cohesion: 0.22
Nodes (11): currentToolbarHeight(), decideDownload(), ensureDownloadConfirmView(), ensureSuggestionsView(), layout(), overlayView(), setViewBounds(), showOverlay() (+3 more)

### Community 26 - "Preload TypeScript Configuration"
Cohesion: 0.18
Nodes (10): compilerOptions, lib, module, moduleResolution, outFile, skipLibCheck, strict, target (+2 more)

### Community 27 - "Release Build Workflows"
Cohesion: 0.20
Nodes (10): macOS DMG and blockmap artifacts, macOS build workflow, Node.js 22 build runtime, TypeScript check, GitHub token publication authentication, Node.js 22 release runtime, Windows and macOS publication workflow, Windows EXE, macOS DMG, blockmaps and update metadata (+2 more)

### Community 28 - "Developer Tools Interface"
Cohesion: 0.29
Nodes (7): Element background, text and border color picker, Skipy Developer Tools, API request and response inspector, HTML color picker tab, SDT developer tools renderer, Runtime secret value prompt, UI test projects, suites, steps and run history

### Community 29 - "Renderer TypeScript Configuration"
Cohesion: 0.20
Nodes (9): compilerOptions, lib, module, moduleResolution, noEmit, skipLibCheck, strict, target (+1 more)

### Community 30 - "Tab Navigation"
Cohesion: 0.28
Nodes (9): attachContextMenu(), certificateForUrl(), contextDownload(), createTab(), loadPage(), navigate(), resolveInput(), restoreClosedTab() (+1 more)

### Community 31 - "Page Automation Commands"
Cohesion: 0.25
Nodes (3): pageCommand(), listen(), push()

### Community 32 - "Overlay Dialog Interface"
Cohesion: 0.25
Nodes (7): Download confirmation with custom location, Shared library panel, Overlay download confirmation, Site JavaScript dialog, Overlay library panel, Floating overlay renderer, SWP permission prompt with once and persistent decisions

### Community 33 - "Audio Renderer Bridge"
Cohesion: 0.40
Nodes (3): AudioBridge, stop(), Window

### Community 34 - "Address Suggestions Renderer"
Cohesion: 0.40
Nodes (3): Bridge, Row, State

## Knowledge Gaps
- **224 isolated node(s):** `name`, `version`, `private`, `description`, `productName` (+219 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 271 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `electron` connect `Developer Tools Storage` to `Package Dependencies`, `Main Process Coordination`, `Website Protection`, `Overlay Panels`, `Network Privacy Logging`, `Library Persistence`, `Developer Tools Smoke Tests`, `Updates and Fingerprint Protection`, `Private Session Smoke Tests`?**
  _High betweenness centrality (0.132) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _224 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Developer Tools Storage` be split into smaller, more focused modules?**
  _Cohesion score 0.06095481670929241 - nodes in this community are weakly interconnected._
- **Why does `SdtService` connect `Developer Tools Service` to `Developer Tools Storage`, `Main Process Coordination`, `Test Run Controller`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Should `Browser Main Renderer` be split into smaller, more focused modules?**
  _Cohesion score 0.06578947368421052 - nodes in this community are weakly interconnected._
- **Why does `lucide` connect `Package Dependencies` to `Browser Main Renderer`, `Developer Tools Renderer`, `Overlay Panels`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **Should `Package Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.058823529411764705 - nodes in this community are weakly interconnected._
## Extraction limitations

Semantic extraction token usage is unavailable from the agent tool. Zero token counters are placeholders, not measured usage. Five code files yielded no symbols. Diagnostics found 7 dangling-endpoint edges, 12 self-loops, and 91 same-endpoint edges collapsed by the undirected graph.
