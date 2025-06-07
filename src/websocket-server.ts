
import { WebSocketServer, WebSocket } from 'ws';
import { translateAudio, type TranslateAudioInput } from './ai/flows/translate-audio';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig(); // Carrega variáveis de ambiente do .env

const PORT = parseInt(process.env.WEBSOCKET_PORT || '3001', 10);

const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Iniciado em ws://localhost:${PORT}`);

const AUDIO_CHUNKS_TO_ACCUMULATE = 3; 
const INACTIVITY_TIMEOUT_MS = 1500; 
const PROCESSING_DELAY_MS = 3000; // Mantendo o delay aumentado

interface ClientState {
  audioBuffer: Blob[];
  inactivityTimer: NodeJS.Timeout | null;
  sourceLanguage: string | null;
  targetLanguage: string | null; // Ainda pode ser enviado pelo cliente, mas não usado pelo fluxo agora
  isProcessing: boolean; 
  messageQueue: Buffer[]; 
}
const clientStates = new Map<WebSocket, ClientState>();

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function processClientAudio(ws: WebSocket) {
  const clientState = clientStates.get(ws);
  if (!clientState || clientState.isProcessing || clientState.audioBuffer.length < AUDIO_CHUNKS_TO_ACCUMULATE) {
    if (clientState && !clientState.isProcessing && clientState.audioBuffer.length > 0) {
        if (clientState.inactivityTimer) clearTimeout(clientState.inactivityTimer);
        clientState.inactivityTimer = setTimeout(() => {
            if (!clientState.isProcessing && clientState.audioBuffer.length > 0) { 
                console.log(`[WebSocketServer] Inactivity timeout reached for client, processing ${clientState.audioBuffer.length} chunks.`);
                processClientAudio(ws); 
            }
        }, INACTIVITY_TIMEOUT_MS);
    }
    return;
  }

  clientState.isProcessing = true;
  if (clientState.inactivityTimer) {
    clearTimeout(clientState.inactivityTimer);
    clientState.inactivityTimer = null;
  }

  const chunksToProcess = clientState.audioBuffer.splice(0, clientState.audioBuffer.length); 
  const combinedBlob = new Blob(chunksToProcess, { type: chunksToProcess[0]?.type || 'audio/webm' });
  
  const arrayBuffer = await combinedBlob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = combinedBlob.type || 'audio/webm';
  const audioDataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;

  if (audioDataUri.split(',')[1]?.length > 0) {
    console.log(`[WebSocketServer] Enviando áudio acumulado para transcrição. MimeType: ${mimeType}, Tamanho DataURI: ${(audioDataUri.length / 1024).toFixed(2)} KB.`);
    console.log(`[WebSocketServer] Início do audioDataUri a ser enviado para o fluxo: ${audioDataUri.substring(0, 100)}...`);
    try {
      const output = await translateAudio({ // A função translateAudio agora só transcreve
        audioDataUri,
        sourceLanguage: clientState.sourceLanguage!,
        targetLanguage: clientState.targetLanguage!, // Passado, mas ignorado pelo fluxo por enquanto
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ transcribedText: output.transcribedText })); // Alterado de translatedText para transcribedText
        console.log(`[WebSocketServer] Texto transcrito enviado: "${output.transcribedText}"`);
      }
    } catch (error: any) {
      console.error('[WebSocketServer] Erro ao transcrever áudio acumulado:', error.message || error);
      let errorMessage = 'Erro ao processar áudio acumulado para transcrição.';
      let traceId: string | undefined;
      let errorDetails: any | undefined;

      if (error instanceof Error) { 
        errorMessage = error.message;
        const genkitError = error as any; // Para acessar propriedades como traceId, errorDetails
        if (genkitError.name === 'GoogleGenerativeAIFetchError' || error.constructor.name === 'GoogleGenerativeAIFetchError') {
            traceId = genkitError.traceId;
            errorDetails = genkitError.errorDetails; 
            errorMessage = `[GoogleGenerativeAI Error]: ${error.message}`; 
            if (errorDetails) {
                errorMessage += ` Details: ${JSON.stringify(errorDetails)}`;
            }
            if (traceId) {
                errorMessage += ` Trace ID: ${traceId}`;
            }
        }
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      console.log(`[WebSocketServer] Enviando erro para o cliente: ${errorMessage}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
            error: `Erro do servidor (transcrição acumulada): ${errorMessage}`
        }));
      }
    }
  } else {
    console.warn('[WebSocketServer] Áudio acumulado resultou em Data URI vazio.');
  }
  
  await delay(PROCESSING_DELAY_MS);
  clientState.isProcessing = false;

  if (clientState.audioBuffer.length >= AUDIO_CHUNKS_TO_ACCUMULATE) {
     console.log('[WebSocketServer] Buffer tem mais chunks suficientes após processamento, disparando próximo processamento.');
     processClientAudio(ws); 
  } else if (clientState.audioBuffer.length > 0) {
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
    targetLanguage: null, // Pode ser definido pelo cliente, mas não usado ativamente na transcrição
    isProcessing: false,
    messageQueue: [],
  });

  ws.on('message', async (message: Buffer) => {
    const clientState = clientStates.get(ws);
    if (!clientState) return;
    
    try {
      const dataString = message.toString();
      let parsedData: Partial<TranslateAudioInput & { audioDataUri?: string }>;

      try {
        parsedData = JSON.parse(dataString);
      } catch (e) {
        console.warn(`[WebSocketServer] Falha ao parsear JSON: "${dataString.substring(0,100)}..."`, e);
        if (ws.readyState === WebSocket.OPEN) {
         ws.send(JSON.stringify({ error: `Formato de mensagem inválido (não é JSON)` }));
        }
        return;
      }

      if (parsedData.sourceLanguage) clientState.sourceLanguage = parsedData.sourceLanguage;
      if (parsedData.targetLanguage) clientState.targetLanguage = parsedData.targetLanguage; // Armazena, mas fluxo ignora

      const audioDataUriChunk = parsedData.audioDataUri;

      if (!audioDataUriChunk || !clientState.sourceLanguage ) { // targetLanguage não é mais crucial para o fluxo atual
        console.warn(`[WebSocketServer] Mensagem inválida recebida (campos faltando): ${dataString.substring(0,100)}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ error: 'Formato de mensagem inválido.' }));
        }
        return;
      }
      
      const base64Marker = ';base64,';
      const base64StartIndex = audioDataUriChunk.indexOf(base64Marker);

      if (base64StartIndex === -1 || audioDataUriChunk.substring(base64StartIndex + base64Marker.length).trim() === '') {
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

      if (clientState.audioBuffer.length >= AUDIO_CHUNKS_TO_ACCUMULATE) {
        if (!clientState.isProcessing) {
          if (clientState.inactivityTimer) clearTimeout(clientState.inactivityTimer);
          clientState.inactivityTimer = null;
          processClientAudio(ws);
        }
      } else { 
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
      ws.send(JSON.stringify({ message: 'Conectado com sucesso ao servidor WebSocket LinguaVox (modo transcrição).' }));
      console.log('[WebSocketServer] Mensagem de boas-vindas (modo transcrição) enviada ao cliente.');
    }
  } catch (sendError) {
    console.error('[WebSocketServer] Erro ao enviar mensagem de boas-vindas (modo transcrição):', sendError);
  }
});

wss.on('error', (error: Error) => {
  console.error('[WebSocketServer] Erro no servidor WebSocket geral:', error.message, error);
});

