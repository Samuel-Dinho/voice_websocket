
import { WebSocketServer, WebSocket } from 'ws';
import { translateAudio, type TranslateAudioInput } from './ai/flows/translate-audio';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig(); // Carrega variáveis de ambiente do .env

const PORT = parseInt(process.env.WEBSOCKET_PORT || '3001', 10);

const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Iniciado em ws://localhost:${PORT}`);

const AUDIO_CHUNKS_TO_ACCUMULATE = 3; 
const INACTIVITY_TIMEOUT_MS = 1500; 
const PROCESSING_DELAY_MS = 500; // Delay between processing chunks for the same client

interface ClientState {
  audioBuffer: Blob[];
  inactivityTimer: NodeJS.Timeout | null;
  sourceLanguage: string | null;
  targetLanguage: string | null;
  isProcessing: boolean; // Flag to prevent concurrent processing for the same client
  messageQueue: Buffer[]; // Queue for incoming messages while processing
}
const clientStates = new Map<WebSocket, ClientState>();

// Helper function for delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function processClientAudio(ws: WebSocket) {
  const clientState = clientStates.get(ws);
  if (!clientState || clientState.isProcessing || clientState.audioBuffer.length < AUDIO_CHUNKS_TO_ACCUMULATE) {
    // If not enough chunks, or already processing, or no state, do nothing yet or reset timer
    if (clientState && !clientState.isProcessing && clientState.audioBuffer.length > 0) {
        if (clientState.inactivityTimer) clearTimeout(clientState.inactivityTimer);
        clientState.inactivityTimer = setTimeout(() => {
            if (!clientState.isProcessing && clientState.audioBuffer.length > 0) { // Check again before processing
                console.log(`[WebSocketServer] Inactivity timeout reached for client, processing ${clientState.audioBuffer.length} chunks.`);
                processClientAudio(ws); // Trigger processing due to inactivity
            }
        }, INACTIVITY_TIMEOUT_MS);
    }
    return;
  }

  // Mark as processing
  clientState.isProcessing = true;
  if (clientState.inactivityTimer) {
    clearTimeout(clientState.inactivityTimer);
    clientState.inactivityTimer = null;
  }

  const chunksToProcess = clientState.audioBuffer.splice(0, clientState.audioBuffer.length); // Process all current chunks
  const combinedBlob = new Blob(chunksToProcess, { type: chunksToProcess[0]?.type || 'audio/webm' });
  
  const arrayBuffer = await combinedBlob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = combinedBlob.type || 'audio/webm';
  const audioDataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;

  if (audioDataUri.split(',')[1]?.length > 0) {
    console.log(`[WebSocketServer] Enviando áudio acumulado. MimeType: ${mimeType}, Tamanho DataURI: ${audioDataUri.length} bytes (${(audioDataUri.length / 1024).toFixed(2)} KB).`);
    console.log(`[WebSocketServer] Início do audioDataUri a ser enviado para o fluxo: ${audioDataUri.substring(0, 100)}...`);
    try {
      const output = await translateAudio({
        audioDataUri,
        sourceLanguage: clientState.sourceLanguage!,
        targetLanguage: clientState.targetLanguage!, 
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ translatedText: output.translatedText }));
        console.log(`[WebSocketServer] Texto transcrito (retornado como traduzido) enviado: "${output.translatedText}"`);
      }
    } catch (error: any) {
      console.error('[WebSocketServer] Erro ao transcrever áudio acumulado:', error.message || error);
      let errorMessage = 'Erro ao processar áudio acumulado.';
      if (error.message) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: `Erro do servidor (acumulado): ${errorMessage}` }));
      }
    }
  } else {
    console.warn('[WebSocketServer] Áudio acumulado resultou em Data URI vazio.');
  }
  
  await delay(PROCESSING_DELAY_MS);
  clientState.isProcessing = false;

  // Check if there are more chunks to process that arrived during processing
  if (clientState.audioBuffer.length >= AUDIO_CHUNKS_TO_ACCUMULATE) {
     console.log('[WebSocketServer] Buffer tem mais chunks suficientes após processamento, disparando próximo processamento.');
     processClientAudio(ws); 
  } else if (clientState.audioBuffer.length > 0) {
     // Not enough for a full batch, reset inactivity timer
     if (clientState.inactivityTimer) clearTimeout(clientState.inactivityTimer);
     clientState.inactivityTimer = setTimeout(() => {
        if (!clientState.isProcessing && clientState.audioBuffer.length > 0) {
            console.log(`[WebSocketServer] Inactivity timeout (post-process) para ${clientState.audioBuffer.length} chunks.`);
            processClientAudio(ws);
        }
     }, INACTIVITY_TIMEOUT_MS);
  }
}


wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocketServer] Cliente conectado');
  clientStates.set(ws, {
    audioBuffer: [],
    inactivityTimer: null,
    sourceLanguage: null,
    targetLanguage: null,
    isProcessing: false,
    messageQueue: [],
  });

  ws.on('message', async (message: Buffer) => {
    const clientState = clientStates.get(ws);
    if (!clientState) return;
    
    // For simplicity in this iteration, we'll process messages directly.
    // A more robust queueing for message *parsing* could be added if needed.
    // clientState.messageQueue.push(message); 
    // if (clientState.isProcessingMessages) return; -> this would be for message parsing queue

    // clientState.isProcessingMessages = true; -> for message parsing queue
    // while(clientState.messageQueue.length > 0) {
    //    const currentMessage = clientState.messageQueue.shift()!;
    //    ... parse currentMessage ...
    // }
    // clientState.isProcessingMessages = false; -> for message parsing queue

    try {
      const dataString = message.toString();
      let parsedData: Partial<TranslateAudioInput & { audioDataUri?: string }>;

      try {
        parsedData = JSON.parse(dataString);
      } catch (e) {
        // ... (error handling for JSON parse)
        console.warn(`[WebSocketServer] Falha ao parsear JSON: "${dataString.substring(0,100)}..."`, e);
        if (ws.readyState === WebSocket.OPEN) {
         ws.send(JSON.stringify({ error: `Formato de mensagem inválido (não é JSON)` }));
        }
        return;
      }

      if (parsedData.sourceLanguage) clientState.sourceLanguage = parsedData.sourceLanguage;
      if (parsedData.targetLanguage) clientState.targetLanguage = parsedData.targetLanguage;

      const audioDataUriChunk = parsedData.audioDataUri;

      if (!audioDataUriChunk || !clientState.sourceLanguage || !clientState.targetLanguage) {
        // ... (error handling for missing fields)
        console.warn(`[WebSocketServer] Mensagem inválida recebida (campos faltando): ${dataString.substring(0,100)}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ error: 'Formato de mensagem inválido.' }));
        }
        return;
      }
      
      const base64Marker = ';base64,';
      const base64StartIndex = audioDataUriChunk.indexOf(base64Marker);

      if (base64StartIndex === -1 || audioDataUriChunk.substring(base64StartIndex + base64Marker.length).trim() === '') {
        // ... (error handling for invalid data URI)
        console.warn(`[WebSocketServer] audioDataUri inválido: ${audioDataUriChunk.substring(0,100)}...`);
         if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ error: 'Formato de audioDataUri inválido' }));
         }
        return;
      }
      const mimeTypePart = audioDataUriChunk.substring(5, base64StartIndex);
      const base64Data = audioDataUriChunk.substring(base64StartIndex + base64Marker.length);
      const byteString = Buffer.from(base64Data, 'base64');
      const newBlob = new Blob([byteString], { type: mimeTypePart });

      clientState.audioBuffer.push(newBlob);
      // console.log(`[WebSocketServer] Chunk de áudio adicionado ao buffer. Tamanho do buffer: ${clientState.audioBuffer.length}`);


      if (clientState.audioBuffer.length >= AUDIO_CHUNKS_TO_ACCUMULATE) {
        if (!clientState.isProcessing) {
          if (clientState.inactivityTimer) clearTimeout(clientState.inactivityTimer);
          clientState.inactivityTimer = null;
          processClientAudio(ws);
        } else {
          // console.log('[WebSocketServer] Buffer cheio, mas já processando. Chunk enfileirado.');
        }
      } else { // Not enough chunks, set/reset inactivity timer if not processing
        if (!clientState.isProcessing) {
            if (clientState.inactivityTimer) clearTimeout(clientState.inactivityTimer);
            clientState.inactivityTimer = setTimeout(() => {
                if (!clientState.isProcessing && clientState.audioBuffer.length > 0) {
                    console.log(`[WebSocketServer] Inactivity timeout (on message) para ${clientState.audioBuffer.length} chunks.`);
                    processClientAudio(ws);
                }
            }, INACTIVITY_TIMEOUT_MS);
        }
      }

    } catch (error: any) {
      console.error('[WebSocketServer] Erro no manipulador de mensagens:', error.message || error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: `Erro do servidor ao processar sua mensagem.` }));
      }
    }
  });

  ws.on('close', (code, reason) => {
    const reasonText = reason ? reason.toString('utf8') : 'Nenhuma razão especificada';
    console.log(`[WebSocketServer] Cliente desconectado. Código: ${code}, Razão: "${reasonText}"`);
    const clientState = clientStates.get(ws);
    if (clientState && clientState.inactivityTimer) {
      clearTimeout(clientState.inactivityTimer);
    }
    clientStates.delete(ws);
  });

  ws.on('error', (error: Error) => {
    console.error('[WebSocketServer] Erro na conexão WebSocket individual do cliente:', error.message, error);
    const clientState = clientStates.get(ws);
    if(clientState) clientState.isProcessing = false; 
  });

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ message: 'Conectado com sucesso ao servidor WebSocket LinguaVox (com acumulação).' }));
      console.log('[WebSocketServer] Mensagem de boas-vindas (acumulação) enviada ao cliente.');
    }
  } catch (sendError) {
    console.error('[WebSocketServer] Erro ao enviar mensagem de boas-vindas (acumulação):', sendError);
  }
});

wss.on('error', (error: Error) => {
  console.error('[WebSocketServer] Erro no servidor WebSocket geral:', error.message, error);
});
