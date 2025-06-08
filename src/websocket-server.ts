
// src/websocket-server.ts
'use server';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
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
// Cache to avoid reprocessing identical consecutive transcriptions for the same client stream
const lastProcessedTextInfo = new Map<WebSocket, string>(); 


// --- Main Connection Logic ---
wss.on('connection', (ws: WebSocket) => {
  const clientId = Date.now().toString() + Math.random().toString(36).substring(2,7);
  console.log(`[WebSocketServer] Client ${clientId} connected.`);

  ws.on('message', async (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      // Handle binary audio chunk
      const audioBuffer = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
      const transcriber = activeTranscribers.get(ws);
      if (transcriber) {
        transcriber.addAudioChunk(audioBuffer);
      } else {
        // console.warn(`[WebSocketServer] Client ${clientId} sent audio chunk without active transcription stream.`);
      }
      return;
    }

    // Handle text message (should be JSON control message)
    const messageString = data.toString();
    let parsedData: any;
    try {
      parsedData = JSON.parse(messageString);
    } catch (e) {
      console.error(`[WebSocketServer] Client ${clientId} sent invalid JSON string:`, messageString, e);
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
          lastProcessedTextInfo.delete(ws); // Clear cache for the old stream
        }

        const transcriber = new RealtimeTranscriber({
          language: language || 'pt', // Default to 'pt' if not provided
          model: model || 'base',     // Default to 'base' if not provided
          targetLanguage: targetLanguage || 'en', // Default to 'en'
          onTranscriptionReady: async (fullTranscription: string, tlForThisSegment: string) => {
            console.log(`[TranscriberCallback-${clientId}] Full Transcription: "${fullTranscription.substring(0, 50)}..." for target ${tlForThisSegment}`);
            if (!fullTranscription.trim()) {
                // console.log(`[TranscriberCallback-${clientId}] Empty transcription, skipping translation.`);
                return;
            }

            const textToTranslate = fullTranscription;
            // language for translation source is the one originally provided in 'start_transcription_stream'
            const sourceLanguageForTranslation = language || 'pt'; 
            
            // Cache logic: if the exact same transcribed text, source lang, and target lang are processed consecutively for this client's stream
            const cacheKey = `${textToTranslate}-${sourceLanguageForTranslation}-${tlForThisSegment}`;
            if (lastProcessedTextInfo.get(ws) === cacheKey) {
                 console.log(`[TranscriberCallback-${clientId}] Cache hit for client ${ws}. Skipping re-translation for: "${textToTranslate.substring(0,30)}..."`);
                 // Optionally resend the last known good translation if needed, though this might be redundant if client already has it
                 if (lastBroadcastedTranslation && lastBroadcastedTranslation.text && ws.readyState === WebSocket.OPEN) {
                    // ws.send(JSON.stringify({ type: 'translated_text_for_listener', ...lastBroadcastedTranslation }));
                 }
                 return;
            }
            lastProcessedTextInfo.set(ws, cacheKey);

            try {
              const translationInput: ImproveTranslationAccuracyInput = {
                text: textToTranslate,
                sourceLanguage: sourceLanguageForTranslation,
                targetLanguage: tlForThisSegment,
              };
              // console.log(`[TranscriberCallback-${clientId}] Sending to translation: "${textToTranslate.substring(0,30)}..." -> ${tlForThisSegment}`);
              const translationOutput = await improveTranslationAccuracy(translationInput);
              const translatedText = translationOutput.translatedText;
              
              console.log(`[TranscriberCallback-${clientId}] Translated: "${translatedText.substring(0, 50)}..."`);
              
              const translationPayload = {
                type: 'translated_text_for_listener',
                text: translatedText,
                targetLanguage: tlForThisSegment
              };

              // Send to the main client that initiated the transcription
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(translationPayload));
              }
              
              // Update last general broadcasted translation (for new listeners joining)
              lastBroadcastedTranslation = { text: translatedText, targetLanguage: tlForThisSegment };
              
              // Also broadcast to other listeners
              audioSubscribers.forEach(subscriber => {
                // Don't send to the originating client again if they happen to be in audioSubscribers
                // (though typically they wouldn't subscribe_audio for their own stream feedback this way)
                if (subscriber !== ws && subscriber.readyState === WebSocket.OPEN) { 
                  subscriber.send(JSON.stringify(translationPayload));
                }
              });
            } catch (translationError: any) {
              console.error(`[TranscriberCallback-${clientId}] Error translating text:`, translationError.message);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: `Translation error: ${translationError.message}`}));
              }
            }
          },
          onError: (error) => {
            console.error(`[RealtimeTranscriber-${clientId}] Instance Error:`, error.message);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: `Transcription stream error: ${error.message}`}));
            }
          }
        });
        
        activeTranscribers.set(ws, transcriber);
        transcriber.start();
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
          lastProcessedTextInfo.delete(ws); // Clear cache for this client's stream
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
        console.warn(`[WebSocketServer] Client ${clientId} sent unknown action: ${action}`, parsedData);
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
      lastProcessedTextInfo.delete(ws); // Clean up cache for the disconnected client
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[WebSocketServer] SIGINT received. Shutting down...');
  wss.clients.forEach(client => {
    const transcriber = activeTranscribers.get(client);
    if (transcriber) {
      transcriber.stop();
    }
    client.close(1012, "Server is restarting"); // 1012 Service Restart
  });
  wss.close(err => {
    if (err) {
      console.error('[WebSocketServer] Error closing WebSocket server:', err);
    }
    console.log('[WebSocketServer] Server closed.');
    process.exit(0);
  });
});
process.on('SIGTERM', () => {
    // Similar to SIGINT
    console.log('[WebSocketServer] SIGTERM received. Shutting down...');
    wss.clients.forEach(client => {
        const transcriber = activeTranscribers.get(client);
        if (transcriber) {
            transcriber.stop();
        }
        client.close(1012, "Server is shutting down");
    });
    wss.close(err => {
        if (err) {
            console.error('[WebSocketServer] Error closing WebSocket server during SIGTERM:', err);
        }
        console.log('[WebSocketServer] Server closed (SIGTERM).');
        process.exit(0);
    });
});
