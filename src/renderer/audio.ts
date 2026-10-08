export {}

type AudioBridge = {
  onStart(callback: (db: number, frequency: number, muted: boolean) => void): void
  onUpdate(callback: (db: number, frequency: number, muted: boolean) => void): void
  onStop(callback: () => void): void
  status(kind: 'active' | 'error', message?: string): void
}
declare global { interface Window { skipyAudio: AudioBridge } }

let stream: MediaStream | null = null
let context: AudioContext | null = null
let highpass: BiquadFilterNode | null = null
let shelf: BiquadFilterNode | null = null
let input: GainNode | null = null
let output: GainNode | null = null
let starting = false
function bassLevel(db: number) { return Number.isFinite(db) ? Math.min(6, Math.max(0, db)) : 0 }
function bassFrequency(frequency: number) { return Number.isFinite(frequency) ? Math.min(100, Math.max(60, frequency)) : 80 }
function inputLevel(db: number) { return Math.pow(10, -bassLevel(db) / 20) }

async function stop() {
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  output?.disconnect()
  highpass?.disconnect()
  shelf?.disconnect()
  input?.disconnect()
  output = null
  highpass = null
  shelf = null
  input = null
  if (context) await context.close().catch(() => undefined)
  context = null
}

window.skipyAudio.onStart(async (db, frequency, muted) => {
  if (starting) return
  starting = true
  const timeout = setTimeout(() => window.skipyAudio.status('error', 'A hangrögzítés nem indult el időben.'), 8000)
  await stop()
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    stream.getVideoTracks().forEach(track => track.stop())
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error('Nincs hangcsatorna a lapon.')
    context = new AudioContext()
    db = bassLevel(db)
    frequency = bassFrequency(frequency)
    input = context.createGain()
    input.gain.value = inputLevel(db)
    highpass = context.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 25
    highpass.Q.value = 0.7
    shelf = context.createBiquadFilter()
    shelf.type = 'lowshelf'
    shelf.frequency.value = frequency
    shelf.gain.value = db
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -1.5
    compressor.knee.value = 1
    compressor.ratio.value = 18
    compressor.attack.value = 0.002
    compressor.release.value = 0.12
    output = context.createGain()
    output.gain.value = muted ? 0 : 1
    context.createMediaStreamSource(stream).connect(input).connect(highpass).connect(shelf).connect(compressor).connect(output).connect(context.destination)
    await context.resume()
    track.addEventListener('ended', () => { void stop(); window.skipyAudio.status('error', 'A lap hangrögzítése megszakadt.') }, { once: true })
    window.skipyAudio.status('active')
  } catch (error) {
    await stop()
    window.skipyAudio.status('error', error instanceof Error ? error.message : 'A hangrögzítés nem sikerült.')
  } finally { clearTimeout(timeout); starting = false }
})
window.skipyAudio.onUpdate((db, frequency, muted) => {
  db = bassLevel(db)
  frequency = bassFrequency(frequency)
  if (input && context) input.gain.setTargetAtTime(inputLevel(db), context.currentTime, 0.045)
  if (shelf && context) {
    shelf.gain.setTargetAtTime(db, context.currentTime, 0.045)
    shelf.frequency.setTargetAtTime(frequency, context.currentTime, 0.045)
  }
  if (output && context) output.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, 0.01)
})
window.skipyAudio.onStop(() => { void stop() })
