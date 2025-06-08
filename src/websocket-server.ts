
// src/websocket-server.ts
'use server';
import { WebSocketServer, WebSocket } from 'ws';
import { config as dotenvConfig } from 'dotenv';
import { improveTranslationAccuracy, type ImproveTranslationAccuracyInput } from './ai/flows/improve-translation-accuracy';
import { RealtimeTranscriber } from './services/RealtimeTranscriber'; 

dotenvConfig();

const PORT = parseInt(process.env.NEXT_PUBLIC_WEBSOCKET_PORT || process.env.WEBSOCKET_PORT || '3001', 10);
const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Started on ws://localhost:${PORT}`);

// --- Server State Management ---
const audioSubscribers = new Set<WebSocket>(); // Listeners for final translations
const activeTranscribers = new Map<WebSocket, RealtimeTranscriber>(); // Maps speaking clients to their transcriber instances
let lastBroadcastedTranslation: { text: string; targetLanguage: string; } | null = null;


// --- Main Connection Logic ---
wss.on('connection', (ws: WebSocket) => {
  const clientId = Date.now().toString() + Math.random().toString(36).substring(2,7);
  console.log(`[WebSocketServer] Client ${clientId} connected.`);

  ws.on('message', async (message: Buffer | string) => {
    if (message instanceof Buffer) {
      // Handle binary audio chunk
      const transcriber = activeTranscribers.get(ws);
      if (transcriber) {
        transcriber.addAudioChunk(message);
      } else {
        // console.warn(`[WebSocketServer] Client ${clientId} sent audio chunk without active transcription stream.`);
      }
      return;
    }

    // Handle JSON control message
    let parsedData: any;
    try {
      parsedData = JSON.parse(message);
    } catch (e) {
      console.error(`[WebSocketServer] Client ${clientId} sent invalid JSON:`, message, e);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: 'Invalid JSON message received.' }));
      }
      return;
    }

    const { action, language, targetLanguage, model } = parsedData;
    // console.log(`[WebSocketServer] Client ${clientId} sent action: ${action}`, parsedData);

    switch (action) {
      case 'start_transcription_stream': {
        console.log(`[WebSocketServer] Client ${clientId} initiated 'start_transcription_stream'. Lang: ${language}, TargetLang: ${targetLanguage}, Model: ${model}`);
        if (activeTranscribers.has(ws)) {
          console.warn(`[WebSocketServer] Client ${clientId} already has an active stream. Stopping old one.`);
          activeTranscribers.get(ws)?.stop();
          activeTranscribers.delete(ws);
        }

        const transcriber = new RealtimeTranscriber({
          language: language || 'pt',
          model: model || 'base',
          targetLanguage: targetLanguage || 'en',
          onTranscriptionReady: async (fullTranscription: string, tl: string) => {
            console.log(`[TranscriberCallback-${clientId}] Full Transcription: "${fullTranscription.substring(0, 50)}..." for target ${tl}`);
            if (!fullTranscription.trim()) {
                // console.log(`[TranscriberCallback-${clientId}] Empty transcription, skipping translation.`);
                return;
            }
            try {
              const translationInput: ImproveTranslationAccuracyInput = {
                text: fullTranscription,
                sourceLanguage: language || 'pt',
                targetLanguage: tl,
              };
              // console.log(`[TranscriberCallback-${clientId}] Sending to translation: "${fullTranscription.substring(0,30)}..." -> ${tl}`);
              const translationOutput = await improveTranslationAccuracy(translationInput);
              const translatedText = translationOutput.translatedText;
              
              // console.log(`[TranscriberCallback-${clientId}] Translated: "${translatedText.substring(0, 50)}..."`);
              
              lastBroadcastedTranslation = { text: translatedText, targetLanguage: tl };
              
              audioSubscribers.forEach(subscriber => {
                if (subscriber.readyState === WebSocket.OPEN) {
                  subscriber.send(JSON.stringify({
                    type: 'translated_text_for_listener',
                    text: translatedText,
                    targetLanguage: tl
                  }));
                }
              });
            } catch (translationError: any) {
              console.error(`[TranscriberCallback-${clientId}] Error translating text:`, translationError.message);
              // Optionally notify client about translation error
            }
          },
          onError: (error) => {
            console.error(`[RealtimeTranscriber-${clientId}] Instance Error:`, error.message);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: `Transcription stream error: ${error.message}`}));
            }
          }
        });
        
        transcriber.start();
        activeTranscribers.set(ws, transcriber);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ message: 'Transcription stream started successfully.'}));
        }
        break;
      }
        
      case 'stop_transcription_stream': {
        console.log(`[WebSocketServer] Client ${clientId} initiated 'stop_transcription_stream'.`);
        const transcriber = activeTranscribers.get(ws);
        if (transcriber) {
          transcriber.stop();
          activeTranscribers.delete(ws);
          console.log(`[WebSocketServer] Transcription stream stopped for client ${clientId}.`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ message: 'Transcription stream stopped successfully.'}));
          }
        } else {
           console.warn(`[WebSocketServer] Client ${clientId} tried to stop a non-existent stream.`);
        }
        break;
      }

      case 'subscribe_audio': {
        audioSubscribers.add(ws);
        console.log(`[WebSocketServer] Client ${clientId} subscribed as listener. Total listeners: ${audioSubscribers.size}`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ message: 'Subscribed to receive translated audio.' }));
        }
        if (lastBroadcastedTranslation) {
          // console.log(`[WebSocketServer] Sending last known translation to new listener ${clientId}...`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'translated_text_for_listener',
              ...lastBroadcastedTranslation
            }));
          }
        }
        break;
      }
        
      default:
        console.warn(`[WebSocketServer] Client ${clientId} sent unknown action: ${action}`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ error: `Action '${action}' not recognized.` }));
        }
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[WebSocketServer] Client ${clientId} disconnected. Code: ${code}, Reason: ${reason.toString()}`);
    const transcriber = activeTranscribers.get(ws);
    if (transcriber) {
      transcriber.stop();
      activeTranscribers.delete(ws);
      console.log(`[WebSocketServer] Active transcriber cleaned up for client ${clientId}.`);
    }
    if (audioSubscribers.has(ws)) {
      audioSubscribers.delete(ws);
      console.log(`[WebSocketServer] Audio subscriber removed for client ${clientId}. Total listeners: ${audioSubscribers.size}`);
    }
  });

  ws.on('error', (error: Error) => {
    console.error(`[WebSocketServer] Error for client ${clientId}:`, error);
    // Cleanup is generally handled by 'close' event which often follows 'error'
  });
  
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ message: 'Connected successfully to LinguaVox WebSocket server.' }));
  }
});

wss.on('error', (error: Error) => {
  console.error('[WebSocketServer] General server error:', error);
});
