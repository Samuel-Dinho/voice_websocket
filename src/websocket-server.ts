
import { WebSocketServer, WebSocket } from 'ws';
import { translateAudio, type TranslateAudioInput } from './ai/flows/translate-audio';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig(); // Carrega variáveis de ambiente do .env

const PORT = parseInt(process.env.WEBSOCKET_PORT || '3001', 10);

const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Iniciado em ws://localhost:${PORT}`);

// Configurações para acumulação de áudio
const AUDIO_CHUNKS_TO_ACCUMULATE = 3; // Acumular aprox. 3 segundos (cada chunk é de 1s)
const INACTIVITY_TIMEOUT_MS = 1500; // Enviar se houver 1.5s de inatividade

// Estruturas para armazenar dados por cliente
interface ClientState {
  audioBuffer: Blob[];
  inactivityTimer: NodeJS.Timeout | null;
  sourceLanguage: string | null;
  targetLanguage: string | null;
}
const clientStates = new Map<WebSocket, ClientState>();


async function processAndSendAudio(ws: WebSocket) {
  const clientState = clientStates.get(ws);
  if (!clientState || clientState.audioBuffer.length === 0 || !clientState.sourceLanguage || !clientState.targetLanguage) {
    // console.log('[WebSocketServer] Nada para processar ou informações de idioma ausentes.');
    return;
  }

  const combinedBlob = new Blob(clientState.audioBuffer, { type: clientState.audioBuffer[0].type });
  clientState.audioBuffer = []; // Limpar buffer após o processamento

  if (clientState.inactivityTimer) {
    clearTimeout(clientState.inactivityTimer);
    clientState.inactivityTimer = null;
  }

  // Converter Blob para Data URI usando Buffer (adequado para Node.js)
  const arrayBuffer = await combinedBlob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = combinedBlob.type || 'audio/webm'; // fallback se o tipo não estiver lá
  const audioDataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;


  if (audioDataUri.split(',')[1]?.length > 0) {
    console.log(`[WebSocketServer] Enviando áudio acumulado (${(audioDataUri.length / 1024).toFixed(2)} KB) para tradução: ${clientState.sourceLanguage} -> ${clientState.targetLanguage}.`);
    try {
      const translationOutput = await translateAudio({
        audioDataUri,
        sourceLanguage: clientState.sourceLanguage,
        targetLanguage: clientState.targetLanguage,
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ translatedText: translationOutput.translatedText }));
        console.log(`[WebSocketServer] Texto traduzido enviado: "${translationOutput.translatedText}"`);
      }
    } catch (error) {
      console.error('[WebSocketServer] Erro ao traduzir áudio acumulado:', error);
      let errorMessage = 'Erro ao processar áudio acumulado.';
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: `Erro do servidor (acumulado): ${errorMessage}` }));
      }
    }
  } else {
    console.warn('[WebSocketServer] Áudio acumulado resultou em Data URI vazio.');
  }
}


wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocketServer] Cliente conectado');
  clientStates.set(ws, { 
    audioBuffer: [], 
    inactivityTimer: null,
    sourceLanguage: null,
    targetLanguage: null,
  });

  ws.on('message', async (message: Buffer) => {
    const clientState = clientStates.get(ws);
    if (!clientState) return;

    try {
      const dataString = message.toString();
      let parsedData: Partial<TranslateAudioInput & { audioChunkDataUri?: string, audioDataUri?: string }>;

      try {
        parsedData = JSON.parse(dataString);
      } catch (e) {
        const errorDetail = e instanceof Error ? e.message : String(e);
        console.warn(`[WebSocketServer] Falha ao parsear JSON: "${dataString.substring(0,200)}..."`, errorDetail);
        if (ws.readyState === WebSocket.OPEN) {
         ws.send(JSON.stringify({ error: `Formato de mensagem inválido (não é JSON): ${errorDetail}` }));
        }
        return;
      }
      
      // Atualiza os idiomas se eles vierem na mensagem
      if (parsedData.sourceLanguage) clientState.sourceLanguage = parsedData.sourceLanguage;
      if (parsedData.targetLanguage) clientState.targetLanguage = parsedData.targetLanguage;


      // O cliente envia audioDataUri para cada chunk
      const audioDataUriChunk = parsedData.audioDataUri; 

      if (!audioDataUriChunk || !clientState.sourceLanguage || !clientState.targetLanguage) {
        const errorMsg = 'Formato de mensagem inválido. Campos obrigatórios: audioDataUri (para o chunk), sourceLanguage, targetLanguage (podem ser enviados uma vez no início ou com cada chunk)';
        console.warn(`[WebSocketServer] Mensagem inválida recebida (campos faltando): ${JSON.stringify(parsedData)}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ error: errorMsg }));
        }
        return;
      }
      
      const base64Marker = ';base64,';
      const base64StartIndex = audioDataUriChunk.indexOf(base64Marker);
      

      if (base64StartIndex === -1 || audioDataUriChunk.substring(base64StartIndex + base64Marker.length).trim() === '') {
        const errorMsg = 'Formato de audioDataUri inválido ou dados de áudio ausentes após a codificação base64.';
        console.warn(`[WebSocketServer] audioDataUri inválido (sem dados base64) recebido: ${audioDataUriChunk.substring(0, 200)}...`);
        if (ws.readyState === WebSocket.OPEN) {
         ws.send(JSON.stringify({ error: errorMsg }));
        }
        return;
      }
      const mimeTypePart = audioDataUriChunk.substring(5, base64StartIndex); // e.g. audio/webm;codecs=opus
      
      // Converter o data URI do chunk de volta para Blob
      const base64Data = audioDataUriChunk.substring(base64StartIndex + base64Marker.length);
      const byteString = Buffer.from(base64Data, 'base64');
      const newBlob = new Blob([byteString], { type: mimeTypePart });

      clientState.audioBuffer.push(newBlob);
      // console.log(`[WebSocketServer] Chunk de áudio adicionado ao buffer. Total de chunks: ${clientState.audioBuffer.length}`);


      if (clientState.inactivityTimer) {
        clearTimeout(clientState.inactivityTimer);
      }

      if (clientState.audioBuffer.length >= AUDIO_CHUNKS_TO_ACCUMULATE) {
        // console.log('[WebSocketServer] Buffer cheio, processando áudio.');
        await processAndSendAudio(ws);
      } else {
        clientState.inactivityTimer = setTimeout(async () => {
          // console.log('[WebSocketServer] Timeout de inatividade, processando áudio.');
          await processAndSendAudio(ws);
        }, INACTIVITY_TIMEOUT_MS);
      }

    } catch (error) {
      console.error('[WebSocketServer] Erro ao processar mensagem ou acumular áudio:', error);
      let errorMessage = 'Erro ao processar mensagem ou durante a acumulação.';
      if (error instanceof Error) {
          errorMessage = error.message; 
      }
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ error: `Erro do servidor: ${errorMessage}` }));
        } catch (sendError) {
          console.error('[WebSocketServer] Erro crítico: Não foi possível enviar mensagem de erro para o cliente:', sendError);
        }
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
    
