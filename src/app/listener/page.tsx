
"use client";

import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Volume2, WifiOff, Loader2, Mic, PlayCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type ListenerState = "connecting" | "connected" | "disconnected" | "error";

export default function ListenerPage() {
  const ws = useRef<WebSocket | null>(null);
  const [listenerState, setListenerState] = useState<ListenerState>("connecting");
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const utteranceQueueRef = useRef<SpeechSynthesisUtterance[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [audioActivated, setAudioActivated] = useState(false);

  const getWebSocketUrl = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = process.env.NEXT_PUBLIC_WEBSOCKET_PORT || '3001';
    return `${protocol}//${window.location.hostname}:${wsPort}`;
  };

  useEffect(() => {
    const updateVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        setAvailableVoices(voices);
        console.log("[Listener] Vozes de síntese carregadas:", voices.length, voices.map(v => ({name: v.name, lang: v.lang, default: v.default})));
      } else {
        console.log("[Listener] Lista de vozes vazia, aguardando onvoiceschanged.");
      }
    };

    // Tenta carregar vozes imediatamente.
    // Em alguns navegadores, onvoiceschanged pode não disparar se as vozes já estiverem carregadas.
    updateVoices(); 

    if (typeof window !== 'undefined' && window.speechSynthesis) {
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = updateVoices;
        } else {
            // Fallback para navegadores que não suportam onvoiceschanged ou se ele não disparar
            console.warn("[Listener] onvoiceschanged não suportado ou não disparou. Usando fallback de intervalo para carregar vozes.");
            const fallbackInterval = setInterval(() => {
                const voices = window.speechSynthesis.getVoices();
                if (voices.length > 0) {
                    updateVoices();
                    clearInterval(fallbackInterval);
                }
            }, 500); // Verifica a cada 500ms
            return () => clearInterval(fallbackInterval); // Limpa o intervalo ao desmontar
        }
    }

    return () => { // Cleanup onvoiceschanged
      if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const speakNextInQueue = () => {
    if (!audioActivated || isSpeaking || utteranceQueueRef.current.length === 0) {
      if (utteranceQueueRef.current.length === 0 && isSpeaking) {
        setIsSpeaking(false); 
      }
      return;
    }

    setIsSpeaking(true);
    const utterance = utteranceQueueRef.current.shift();

    if (utterance) {
      // Lógica de seleção de voz movida aqui, usando o estado `availableVoices` atual
      const targetLangLC = utterance.lang.toLowerCase(); // utterance.lang foi definido como targetLanguage em onmessage
      const targetLangPrefixLC = targetLangLC.split('-')[0];

      if (availableVoices.length > 0) {
        console.log(`[Listener] Procurando voz para: ${targetLangLC} (prefixo: ${targetLangPrefixLC}) em ${availableVoices.length} vozes disponíveis no momento de falar.`);
      } else {
        console.warn(`[Listener] availableVoices está vazio no momento de falar. Texto: "${utterance.text.substring(0,30)}..."`);
      }

      let voice = availableVoices.find(v => 
        v.lang.toLowerCase().startsWith(targetLangPrefixLC) && v.default === true
      );
      if (!voice) {
        voice = availableVoices.find(v => 
          v.lang.toLowerCase().startsWith(targetLangPrefixLC)
        );
      }
      if (!voice && targetLangLC !== targetLangPrefixLC) { // Se targetLang é específico como 'en-GB' e não achou por prefixo 'en'
        voice = availableVoices.find(v => v.lang.toLowerCase() === targetLangLC);
      }
      
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang; // Usa a tag de idioma específica da voz
        console.log(`[Listener] Voz encontrada e definida: ${voice.name} (${voice.lang}) para o texto: "${utterance.text.substring(0,30)}..."`);
      } else {
        // utterance.lang já está definido como targetLanguage de onmessage
        const voiceCount = availableVoices.length;
        console.warn(`[Listener] Nenhuma voz específica encontrada para ${utterance.lang} nas ${voiceCount} vozes disponíveis. Usando padrão do navegador para o idioma (${utterance.lang}). Texto: "${utterance.text.substring(0,30)}..."`);
      }
      // Fim da lógica de seleção de voz
      
      console.log("[Listener] Tentando falar:", utterance.text.substring(0, 30) + "...", "Idioma:", utterance.lang, "Voz:", utterance.voice?.name);
      
      utterance.onstart = () => {
        console.log("[Listener] Síntese de fala iniciada.");
        setLastMessage(`Falando: "${utterance.text.substring(0,20)}..."`);
      };
      utterance.onend = () => {
        console.log("[Listener] Síntese de fala finalizada.");
        setIsSpeaking(false);
        speakNextInQueue(); 
      };
      utterance.onerror = (event) => {
        console.error(`[Listener] Erro na síntese de fala: ${event.error}. Texto: "${utterance.text.substring(0,30)}..." Detalhes do evento:`, event);
        setLastMessage(`Erro ao falar: ${event.error}`);
        setIsSpeaking(false);
        speakNextInQueue(); 
      };
      window.speechSynthesis.speak(utterance);
    } else {
      console.warn("[Listener] speakNextInQueue chamado mas a fila está vazia após a verificação inicial.");
      setIsSpeaking(false);
    }
  };
  
  const handleActivateAudio = () => {
    setAudioActivated(true);
    setLastMessage("Áudio ativado pelo usuário. Aguardando traduções...");
    console.log("[Listener] Áudio ativado pelo usuário.");
    try {
        // Tenta falar algo muito curto e silencioso para "desbloquear" o áudio
        // Isso precisa acontecer como resultado direto da interação do usuário.
        const unlockUtterance = new SpeechSynthesisUtterance(" "); // Um espaço ou texto muito curto
        unlockUtterance.volume = 0.01; // Quase inaudível
        unlockUtterance.lang = "en-US"; // Um idioma comum
        unlockUtterance.onend = () => {
            console.log("[Listener] Utterance de desbloqueio de áudio finalizada.");
            // Após o desbloqueio, tente falar o que estiver na fila
            speakNextInQueue();
        };
        unlockUtterance.onerror = (event) => {
            console.error("[Listener] Erro na utterance de desbloqueio de áudio:", event.error, "Evento completo:", event);
            speakNextInQueue(); // Tente falar mesmo se o desbloqueio falhar
        };
        window.speechSynthesis.speak(unlockUtterance);
    } catch (e) {
        console.error("[Listener] Erro ao tentar utterance de desbloqueio de áudio:", e);
        speakNextInQueue(); // Tente falar mesmo se o desbloqueio falhar
    }
  };

  useEffect(() => {
    const WS_URL = getWebSocketUrl();
    console.log("[Listener] Tentando conectar ao WebSocket em:", WS_URL);
    setListenerState("connecting");

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      console.log("[Listener] WebSocket conectado.");
      setListenerState("connected");
      setLastMessage("Conectado. Clique em 'Ativar Áudio' se o botão aparecer.");
      if (ws.current) {
        ws.current.send(JSON.stringify({ action: "subscribe_audio" }));
        console.log("[Listener] Mensagem de inscrição enviada.");
      }
    };

    ws.current.onmessage = (event) => {
      console.log("[Listener] Raw message data received:", event.data);
      try {
        const serverMessage = JSON.parse(event.data as string);
        console.log("[Listener] Mensagem parseada recebida. Tipo:", serverMessage.type, "Conteúdo:", serverMessage);

        if (serverMessage.type === "translated_text_for_listener" && serverMessage.text && serverMessage.targetLanguage) {
          setLastMessage(`Texto traduzido recebido para ${serverMessage.targetLanguage} (${new Date().toLocaleTimeString()})`);
          
          const utterance = new SpeechSynthesisUtterance(serverMessage.text);
          utterance.lang = serverMessage.targetLanguage; // Define o idioma inicial, voz específica será escolhida em speakNextInQueue
          
          utteranceQueueRef.current.push(utterance);
          if (audioActivated && !isSpeaking) { // Só começa a falar se o áudio estiver ativado e não estiver falando
            speakNextInQueue();
          }
        } else if (serverMessage.message) {
          // Mensagens informativas do servidor
          setLastMessage(serverMessage.message);
        } else if (serverMessage.error) {
           setLastMessage(`Erro do servidor: ${serverMessage.error}`);
           console.error("[Listener] Erro do servidor WebSocket:", serverMessage.error);
        } else {
            console.warn("[Listener] Mensagem do servidor não reconhecida:", serverMessage);
        }
      } catch (e) {
        console.error("[Listener] Erro ao processar mensagem do servidor (não JSON ou outro erro):", e, "Raw data:", event.data);
        setLastMessage("Erro ao processar dados do servidor.");
      }
    };

    ws.current.onerror = (event) => {
      console.error("[Listener] Erro no WebSocket:", event);
      setListenerState("error");
      setLastMessage("Erro na conexão WebSocket.");
      setIsSpeaking(false); // Reseta estados relacionados à fala
      setAudioActivated(false); // Reseta ativação de áudio
    };

    ws.current.onclose = (event) => {
      console.log(`[Listener] WebSocket desconectado. Código: ${event.code}, Limpo: ${event.wasClean}, Razão: ${event.reason}`);
      setListenerState("disconnected");
      if (event.code !== 1000) { // Se não foi um fechamento limpo intencional
        setLastMessage("Desconectado. Tente recarregar a página.");
      } else {
        setLastMessage("Desconectado do servidor.");
      }
      setIsSpeaking(false); // Reseta estados relacionados à fala
      setAudioActivated(false); // Reseta ativação de áudio
      if(typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel(); // Cancela qualquer fala pendente
      }
      utteranceQueueRef.current = []; // Limpa a fila
    };

    return () => {
      if (ws.current && (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING) ) {
        console.log("[Listener] Fechando WebSocket ao desmontar/re-executar useEffect.");
        ws.current.close(1000, "Listener page unmounting or useEffect re-run");
      }
      ws.current = null;
      if(typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel(); // Garante que a fala pare ao desmontar
      }
      utteranceQueueRef.current = [];
      setIsSpeaking(false); // Garante que o estado de fala seja resetado
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // A lista de dependências está vazia intencionalmente para rodar apenas uma vez no mount/unmount

  return (
    <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-background text-foreground">
      <header className="w-full max-w-3xl mb-8">
        <div className="flex justify-center items-center mb-2">
          <LinguaVoxLogo className="h-12 w-auto" />
        </div>
        <p className="text-muted-foreground text-lg text-center">
          Página do Ouvinte - Reprodução da Tradução
        </p>
        <div className="text-center mt-2">
            <Link href="/" className="text-sm text-primary hover:underline flex items-center justify-center gap-1">
                <Mic size={16} />
                Ir para a Página de Transcrição
            </Link>
        </div>
      </header>

      <main className="w-full max-w-md">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Volume2 className="text-primary" />
              Receptor de Tradução Falada
            </CardTitle>
            <CardDescription>
              Esta página reproduzirá automaticamente a tradução do áudio capturado na página de transcrição.
              {!audioActivated && listenerState === "connected" && " (Requer ativação de áudio abaixo)"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {!audioActivated && listenerState === "connected" && (
              <div className="flex justify-center">
                <Button onClick={handleActivateAudio} className="px-6 py-3 text-base">
                  <PlayCircle size={18} className="mr-2" />
                  Ativar Áudio para Traduções
                </Button>
              </div>
            )}
            <div className="flex items-center justify-center p-6 bg-muted/50 rounded-md min-h-[100px]">
              {listenerState === "connecting" && (
                <div className="flex flex-col items-center text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin mb-2" />
                  Conectando ao servidor...
                </div>
              )}
              {listenerState === "connected" && !audioActivated && (
                 <p className="text-muted-foreground text-center">Clique em "Ativar Áudio" para ouvir as traduções.</p>
              )}
              {listenerState === "connected" && audioActivated && !isSpeaking && utteranceQueueRef.current.length === 0 && (
                <p className="text-muted-foreground">Aguardando tradução para falar...</p>
              )}
              {listenerState === "connected" && audioActivated && (isSpeaking || utteranceQueueRef.current.length > 0) && (
                 <p className="text-primary animate-pulse">
                    {isSpeaking ? "Falando tradução..." : "Tradução na fila para falar..."}
                </p>
              )}
              {(listenerState === "disconnected" || listenerState === "error") && (
                 <div className="flex flex-col items-center text-destructive">
                  <WifiOff className="h-8 w-8 mb-2" />
                  {listenerState === "disconnected" ? "Desconectado." : "Erro de conexão."}
                   {listenerState === "error" && <span className="text-xs">{lastMessage}</span>}
                </div>
              )}
            </div>
            
            {lastMessage && (
              <p className="text-sm text-muted-foreground text-center mt-2">
                Status: {lastMessage}
              </p>
            )}
             {availableVoices.length === 0 && listenerState === "connected" && ( // Mensagem se as vozes ainda não carregaram
                <p className="text-xs text-muted-foreground text-center mt-2">
                    Carregando vozes de síntese... Se a fala não iniciar, verifique as configurações de TTS do seu sistema/navegador.
                </p>
            )}
            {audioActivated && availableVoices.length > 0 && !isSpeaking && utteranceQueueRef.current.length === 0 && ( // Mensagem se áudio ativado e vozes carregadas
                 <p className="text-xs text-muted-foreground text-center mt-2">
                    Áudio ativado. {availableVoices.length} vozes de síntese disponíveis.
                </p>
            )}
          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox Listener. Todos os direitos reservados.</p>
      </footer>
    </div>
  );
}
    
