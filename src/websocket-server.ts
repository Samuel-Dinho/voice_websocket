
import { WebSocketServer, WebSocket } from 'ws';
import { translateAudio, type TranslateAudioInput } from './ai/flows/translate-audio';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig(); // Carrega variáveis de ambiente do .env

const PORT = parseInt(process.env.WEBSOCKET_PORT || '3001', 10);

const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Iniciado em ws://localhost:${PORT}`);

wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocketServer] Cliente conectado');

  ws.on('message', async (message: Buffer) => {
    try {
      const dataString = message.toString();
      const parsedData: TranslateAudioInput = JSON.parse(dataString);

      if (!parsedData.audioDataUri || !parsedData.sourceLanguage || !parsedData.targetLanguage) {
        const errorMsg = 'Formato de mensagem inválido. Campos obrigatórios: audioDataUri, sourceLanguage, targetLanguage';
        console.warn(`[WebSocketServer] Mensagem inválida recebida: ${dataString}`);
        ws.send(JSON.stringify({ error: errorMsg }));
        return;
      }
      
      console.log(`[WebSocketServer] Áudio recebido para tradução: ${parsedData.sourceLanguage} para ${parsedData.targetLanguage}. Tamanho dos dados de áudio: ${parsedData.audioDataUri.length}`);

      const translationOutput = await translateAudio(parsedData);
      ws.send(JSON.stringify({ translatedText: translationOutput.translatedText }));
      console.log(`[WebSocketServer] Texto traduzido enviado: "${translationOutput.translatedText}"`);

    } catch (error) {
      console.error('[WebSocketServer] Erro ao processar mensagem ou traduzir:', error);
      let errorMessage = 'Erro ao processar mensagem ou durante a tradução.';
      if (error instanceof Error) {
          errorMessage = error.message;
      }
      try {
        ws.send(JSON.stringify({ error: errorMessage }));
      } catch (sendError) {
        console.error('[WebSocketServer] Erro ao enviar mensagem de erro para o cliente:', sendError);
      }
    }
  });

  ws.on('close', (code, reason) => {
    const reasonText = reason ? reason.toString() : 'Nenhuma razão especificada';
    console.log(`[WebSocketServer] Cliente desconectado. Código: ${code}, Razão: ${reasonText}`);
  });

  ws.on('error', (error: Error) => {
    console.error('[WebSocketServer] Erro na conexão WebSocket individual do cliente:', error);
  });

  try {
    ws.send(JSON.stringify({ message: 'Conectado com sucesso ao servidor WebSocket LinguaVox.' }));
    console.log('[WebSocketServer] Mensagem de boas-vindas enviada ao cliente.');
  } catch (sendError) {
    console.error('[WebSocketServer] Erro ao enviar mensagem de boas-vindas:', sendError);
    // Considerar fechar a conexão se a mensagem de boas-vindas for crítica
    // ws.close(1011, "Erro interno ao enviar mensagem inicial"); 
  }
});

wss.on('error', (error: Error) => {
  console.error('[WebSocketServer] Erro no servidor WebSocket geral:', error);
});

    