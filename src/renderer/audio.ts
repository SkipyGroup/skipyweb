export {}

type AudioBridge = {
  onStart(callback: (db: number, muted: boolean) => void): void
  onUpdate(callback: (db: number, muted: boolean) => void): void
  onStop(callback: () => void): void
  status(kind: 'active' | 'error', message?: string): void
}
declare global { interface Window { skipyAudio: AudioBridge } }

let stream: MediaStream | null = null
let context: AudioContext | null = null
let shelf: BiquadFilterNode | null = null
let output: GainNode | null = null
let starting = false
function outputLevel(db: number, muted: boolean) { return muted ? 0 : Math.pow(10, -db * 0.18 / 20) }

async function stop() {
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  output?.disconnect()
  shelf?.disconnect()
  output = null
  shelf = null
  if (context) await context.close().catch(() => undefined)
  context = null
}

window.skipyAudio.onStart(async (db, muted) => {
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
    shelf = context.createBiquadFilter()
    shelf.type = 'lowshelf'
    shelf.frequency.value = 95
    shelf.gain.value = db
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -3
    compressor.knee.value = 3
    compressor.ratio.value = 3
    compressor.attack.value = 0.003
    compressor.release.value = 0.25
    output = context.createGain()
    output.gain.value = outputLevel(db, muted)
    context.createMediaStreamSource(stream).connect(shelf).connect(compressor).connect(output).connect(context.destination)
    await context.resume()
    track.addEventListener('ended', () => { void stop(); window.skipyAudio.status('error', 'A lap hangrögzítése megszakadt.') }, { once: true })
    window.skipyAudio.status('active')
  } catch (error) {
    await stop()
    window.skipyAudio.status('error', error instanceof Error ? error.message : 'A hangrögzítés nem sikerült.')
  } finally { clearTimeout(timeout); starting = false }
})
window.skipyAudio.onUpdate((db, muted) => {
  if (shelf && context) shelf.gain.setTargetAtTime(db, context.currentTime, 0.035)
  if (output && context) output.gain.setTargetAtTime(outputLevel(db, muted), context.currentTime, 0.01)
})
window.skipyAudio.onStop(() => { void stop() })
