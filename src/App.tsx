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
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')

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

    setPartials((current) => {
      const pendingTranscripts = Object.entries(current)
        .map(([id, text]) => ({
          id,
          text: text.trim(),
        }))
        .filter((line) => line.text)

      if (pendingTranscripts.length > 0) {
        setTranscripts((existing) => {
          const existingIds = new Set(existing.map((line) => line.id))
          return [
            ...existing,
            ...pendingTranscripts.filter((line) => !existingIds.has(line.id)),
          ]
        })
      }

      return {}
    })
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

      // HERE
      const dataChannel = peerConnection.createDataChannel('openai-realtime-events')
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
  const transcriptText = [
    ...transcripts.map((line) => line.text),
    ...partialTexts,
  ].join('\n')
  const hasTranscript = transcriptText.trim().length > 0

  const copyTranscript = useCallback(async () => {
    if (!hasTranscript) {
      return
    }

    try {
      await navigator.clipboard.writeText(transcriptText)
      setCopyStatus('copied')
      window.setTimeout(() => setCopyStatus('idle'), 300)
    } catch {
      setCopyStatus('error')
    }
  }, [hasTranscript, transcriptText])

  const clearTranscript = useCallback(() => {
    setTranscripts([])
    setPartials({})
    setCopyStatus('idle')
  }, [])

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
            title={isListening ? 'Stop listening' : 'Start listening'}
          >
            <svg className="microphone-icon" viewBox="0 0 24 24">
              <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
              <path d="M19 11a7 7 0 0 1-14 0" />
              <path d="M12 18v3" />
              <path d="M8 21h8" />
            </svg>
          </button>

          <button
            className={`copy-action ${copyStatus === 'copied' ? 'is-copied' : ''}`}
            disabled={!hasTranscript}
            type="button"
            onClick={copyTranscript}
            title={hasTranscript ? 'Copy transcript' : 'No transcript to copy'}
          >
            <svg className="copy-icon" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="8" y="8" width="10" height="12" rx="2" />
              <path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>

          <button
            className="clear-action"
            disabled={!hasTranscript}
            type="button"
            onClick={clearTranscript}
            title={hasTranscript ? 'Clear transcript' : 'No transcript to clear'}
          >
            <svg className="clear-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
            </svg>
          </button>
        </div>
      </section>
    </main>
  )
}

export default App
