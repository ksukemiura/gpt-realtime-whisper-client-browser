import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import './App.css'

type ConnectionState =
  'idle' |
  'connecting' |
  'listening' |
  'stopping' |
  'error'

type TranscriptLine = {
  id: string
  text: string
}

type RealtimeEvent = {
  type?: unknown
  item_id?: unknown
  delta?: unknown
  transcript?: unknown
  error?: {
    message?: unknown
  }
}

function App() {
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)

  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([])
  const [partials, setPartials] = useState<Record<string, string>>({})
  const [errorMessage, setErrorMessage] = useState('')

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      if (typeof event.item_id !== 'string' || typeof event.delta !== 'string') {
        return
      }

      const itemId = event.item_id
      const delta = event.delta

      setPartials((current) => ({
        ...current,
        [itemId]: `${current[itemId] ?? ''}${delta}`,
      }))
      return
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      if (typeof event.item_id !== 'string' || typeof event.transcript !== 'string') {
        return
      }

      const transcript = event.transcript.trim()
      const itemId = event.item_id

      if (transcript) {
        setTranscripts((current) => [
          ...current,
          {
            id: itemId,
            text: transcript,
          },
        ])
      }

      setPartials((current) => {
        const next = { ...current }
        delete next[itemId]
        return next
      })
      return
    }

    if (event.type === 'error') {
      const message =
        typeof event.error?.message === 'string' ? event.error.message : 'Realtime session error'
      setErrorMessage(message)
      setConnectionState('error')
    }
  }, [])

  const stopTranscribing = useCallback(() => {
    setConnectionState((current) => (current === 'idle' ? current : 'stopping'))

    dataChannelRef.current?.close()
    dataChannelRef.current = null

    peerConnectionRef.current?.close()
    peerConnectionRef.current = null

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null

    setPartials({})
    setConnectionState('idle')
  }, [])

  const startTranscribing = useCallback(async () => {
    setErrorMessage('')
    setConnectionState('connecting')

    try {
      const peerConnection = new RTCPeerConnection()
      peerConnectionRef.current = peerConnection

      peerConnection.addEventListener('connectionstatechange', () => {
        if (peerConnection.connectionState === 'connected') {
          setConnectionState('listening')
        }

        if (
          peerConnection.connectionState === 'failed' ||
          peerConnection.connectionState === 'disconnected'
        ) {
          setConnectionState('error')
          setErrorMessage('Realtime connection closed unexpectedly')
        }
      })

      const dataChannel = peerConnection.createDataChannel('oai-events')
      dataChannelRef.current = dataChannel
      dataChannel.addEventListener('message', (message) => {
        try {
          handleRealtimeEvent(JSON.parse(message.data) as RealtimeEvent)
        } catch {
          setErrorMessage('Received an unreadable realtime event')
        }
      })

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      mediaStreamRef.current = mediaStream
      mediaStream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, mediaStream)
      })

      const sdpOffer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(sdpOffer)

      const response = await fetch('/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
        },
        body: sdpOffer.sdp,
      })

      const sdpAnswer = await response.text()

      if (!response.ok) {
        throw new Error(sdpAnswer || `Session request failed with ${response.status}`)
      }

      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: sdpAnswer,
      })
    } catch (error) {
      stopTranscribing()
      setConnectionState('error')
      setErrorMessage(error instanceof Error ? error.message : 'Could not start transcription')
    }
  }, [handleRealtimeEvent, stopTranscribing])

  const toggleTranscribing = useCallback(() => {
    if (connectionState === 'listening' || connectionState === 'error') {
      stopTranscribing()
      return
    }

    void startTranscribing()
  }, [connectionState, startTranscribing, stopTranscribing])

  useEffect(() => stopTranscribing, [stopTranscribing])

  const isBusy = connectionState === 'connecting' || connectionState === 'stopping'
  const isListening = connectionState === 'listening'
  const partialTexts = Object.values(partials).filter(Boolean)

  return (
    <main className="app-shell">
      <section className="recorder">
        <div className="masthead">
          <h1>GPT Realtime Whisper</h1>
        </div>

        <section className="transcript-panel">
          {transcripts.length === 0 && partialTexts.length === 0 ? (
            <p className="empty-state">No transcript yet.</p>
          ) : (
            <>
              <div className="final-lines">
                {transcripts.map((line) => (
                  <p key={line.id}>{line.text}</p>
                ))}
              </div>

              {partialTexts.length > 0 && (
                <div className="partial-lines">
                  {partialTexts.map((line, index) => (
                    <p key={`${line}-${index}`}>{line}</p>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        {errorMessage && <p className="error-message">{errorMessage}</p>}

        <div className="control-row">
          <button
            className={`toggle-action ${isListening ? 'is-active' : ''}`}
            disabled={isBusy}
            type="button"
            onClick={toggleTranscribing}
          >
            <svg className="microphone-icon" viewBox="0 0 24 24">
              <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
              <path d="M19 11a7 7 0 0 1-14 0" />
              <path d="M12 18v3" />
              <path d="M8 21h8" />
            </svg>
          </button>
        </div>
      </section>
    </main>
  )
}

export default App
