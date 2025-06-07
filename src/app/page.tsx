
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, MicOff, Loader2, AlertTriangle, Edit3, LanguagesIcon } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages } from "@/lib/languages";
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";

type StreamingState = "idle" | "recognizing" | "error" | "stopping";

let recognition: SpeechRecognition | null = null;

export default function LinguaVoxPage() {
  const ws = useRef<WebSocket | null>(null);
  const { toast } = useToast(); // Moved inside the component
  const [sourceLanguage, setSourceLanguage] = useState<string>("pt");
  const [targetLanguage, setTargetLanguage] = useState<string>("en");
  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const [transcribedText, setTranscribedText] = useState<string>("");
  const [interimTranscribedText, setInterimTranscribedText] = useState<string>("");
  const [translatedText, setTranslatedText] = useState<string>("");
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const getWebSocketUrl = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = process.env.NEXT_PUBLIC_WEBSOCKET_PORT || '3001';
    return `${protocol}//${window.location.hostname}:${wsPort}`;
  };

  const connectWebSocket = useCallback(() => {
    const WS_URL = getWebSocketUrl();
    console.log("[Client] Tentando conectar ao WebSocket em:", WS_URL);

    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      console.log("[Client] WebSocket já está conectado.");
      return;
    }

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      console.log("[Client] WebSocket conectado (client-side)");
      setError(null);
    };

    ws.current.onmessage = (event) => {
      try {
        const serverMessage = JSON.parse(event.data as string);
        console.log("[Client] Mensagem recebida do servidor:", serverMessage);

        if (serverMessage.translatedText) {
          setTranslatedText(prev => prev ? prev.trim() + " " + serverMessage.translatedText.trim() : serverMessage.translatedText.trim());
          setIsTranslating(false);
        } else if (serverMessage.error) {
          console.error("[Client] Erro do servidor WebSocket:", serverMessage.error);
          setError(`Erro do servidor: ${serverMessage.error}`);
          toast({ title: "Erro na Tradução", description: serverMessage.error, variant: "destructive" });
          setIsTranslating(false);
        } else if (serverMessage.message) {
          console.log("[Client] Mensagem informativa do servidor:", serverMessage.message);
        }
      } catch (e) {
        console.error("[Client] Erro ao processar mensagem do servidor:", e);
        setError("Erro ao processar resposta do servidor.");
        setIsTranslating(false);
      }
    };

    ws.current.onerror = (event) => {
      console.error("[Client] Erro no WebSocket (client-side):", event);
      setError("Falha na conexão WebSocket. Verifique o console.");
      setStreamingState("error");
      setIsTranslating(false);
      toast({ title: "Erro de Conexão", description: "Não foi possível conectar ao servidor WebSocket.", variant: "destructive" });
    };

    ws.current.onclose = (event) => {
      console.log(`[Client] WebSocket desconectado (client-side). Código: ${event.code}, Razão: "${event.reason}", Foi Limpo: ${event.wasClean}. Detalhes do evento:`, event);
      if (streamingState === "recognizing" || streamingState === "stopping") {
        setStreamingState("idle");
      }
       if (ws.current && ws.current === event.target) {
        ws.current = null;
      }
    };
  }, [streamingState, toast]); // Added toast here as it's now part of component scope

  useEffect(() => {
    connectWebSocket();

    return () => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        console.log("[Client] Fechando WebSocket ao desmontar o componente...");
        ws.current.close(1000, "Component unmounting");
      }
      ws.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectWebSocket]); // connectWebSocket will be stable due to its own deps

  const isSpeechRecognitionSupported = useCallback(() => {
    return typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  }, []);

  useEffect(() => {
    if (!isSpeechRecognitionSupported()) {
      setError("Reconhecimento de fala não é suportado pelo seu navegador.");
      setStreamingState("error");
      toast({
        title: "Navegador Incompatível",
        description: "Seu navegador não suporta a API Web Speech para reconhecimento de fala.",
        variant: "destructive",
      });
    }
  }, [toast, isSpeechRecognitionSupported]);

  const startRecognition = useCallback(() => {
    console.log("[Client] Tentando iniciar reconhecimento. Estado atual:", streamingState, "Idioma Fonte:", sourceLanguage);
    if (!isSpeechRecognitionSupported()) {
      setError("Reconhecimento de fala não suportado.");
      setStreamingState("error");
      toast({ title: "Erro Crítico", description: "API de Reconhecimento de Fala não disponível.", variant: "destructive" });
      return;
    }

    if (streamingState === "recognizing") {
      console.warn("[Client] Tentando iniciar reconhecimento quando já está em progresso.");
      return;
    }

    setStreamingState("recognizing");
    setError(null);
    setTranscribedText("");
    setInterimTranscribedText("");
    setTranslatedText("");
    toast({ title: "Microfone Ativado", description: "Iniciando reconhecimento de fala..." });

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
        setError("API de Reconhecimento de Fala não encontrada no navegador.");
        setStreamingState("error");
        toast({ title: "Erro Crítico", description: "API de Reconhecimento de Fala não encontrada.", variant: "destructive" });
        return;
    }
    
    try {
      recognition = new SpeechRecognitionAPI();
    } catch (e: any) {
      console.error("[Client] Erro ao criar instância de SpeechRecognition:", e);
      setError(`Erro ao criar SpeechRecognition: ${e.message}`);
      setStreamingState("error");
      toast({ title: "Erro de Inicialização", description: `Não foi possível criar SpeechRecognition: ${e.message}`, variant: "destructive" });
      return;
    }
    
    recognition.continuous = true;
    recognition.interimResults = true;
    const speechLang = sourceLanguage === "en" ? "en-US" :
                       sourceLanguage === "es" ? "es-ES" :
                       sourceLanguage === "fr" ? "fr-FR" :
                       sourceLanguage === "de" ? "de-DE" :
                       sourceLanguage === "it" ? "it-IT" :
                       sourceLanguage === "pt" ? "pt-BR" :
                       sourceLanguage;
    recognition.lang = speechLang;
    console.log(`[Client] Instância SpeechRecognition criada. Idioma: ${recognition.lang}`);

    recognition.onstart = () => {
      console.log("[Client] SpeechRecognition iniciado com sucesso.");
      setStreamingState("recognizing");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final_transcript = '';
      let interim_transcript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final_transcript += event.results[i][0].transcript;
        } else {
          interim_transcript += event.results[i][0].transcript;
        }
      }
      
      if (final_transcript.trim()) {
         const newFinalText = final_transcript.trim();
         setTranscribedText(prev => (prev ? prev.trim() + " " : "") + newFinalText);
         
         if (ws.current && ws.current.readyState === WebSocket.OPEN) {
           console.log(`[Client] Enviando texto final para tradução: "${newFinalText}"`);
           setIsTranslating(true);
           ws.current.send(JSON.stringify({
             action: "translate",
             text: newFinalText,
             sourceLanguage: sourceLanguage,
             targetLanguage: targetLanguage
           }));
         } else {
           console.warn("[Client] WebSocket não está aberto. Não é possível enviar texto para tradução.");
           setError("Conexão WebSocket perdida. Não é possível traduzir.");
           setIsTranslating(false);
           if (!ws.current) {
             console.log("[Client] Tentando reconectar WebSocket...");
             connectWebSocket();
           }
         }
      }
      setInterimTranscribedText(interim_transcript.trim());
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error("[Client] Erro no SpeechRecognition:", event);
      let errMessage = `Erro no reconhecimento: ${event.error}`;
      if (event.error === 'network') errMessage = "Erro de rede durante o reconhecimento.";
      else if (event.error === 'no-speech') errMessage = "Nenhuma fala detectada.";
      else if (event.error === 'audio-capture') errMessage = "Falha na captura de áudio. Verifique permissões.";
      else if (event.error === 'not-allowed') errMessage = "Permissão do microfone negada.";
      else if (event.error === 'language-not-supported') errMessage = `Idioma '${recognition?.lang}' não suportado.`;
      else if (event.message) errMessage += `. Detalhes: ${event.message}`;
      
      setError(errMessage);
      setStreamingState("error");
      toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      if (recognition && (streamingState === "recognizing" || streamingState === "stopping")) {
        recognition.stop();
      }
    };

    recognition.onend = () => {
      console.log("[Client] SpeechRecognition finalizado. Estado atual:", streamingState);
      if (streamingState === "recognizing" || streamingState === "stopping") {
        setStreamingState("idle");
        setInterimTranscribedText(""); 
      }
    };
    
    console.log("[Client] Chamando recognition.start()...");
    try {
      recognition.start();
    } catch (e: any) {
      console.error("[Client] Erro ao chamar recognition.start():", e);
      setError(`Erro ao iniciar reconhecimento: ${e.message}`);
      setStreamingState("error");
      toast({ title: "Erro ao Iniciar", description: `Não foi possível iniciar o reconhecimento: ${e.message}`, variant: "destructive" });
      if (recognition && (streamingState === "recognizing" || streamingState === "stopping")) {
        recognition.stop();
      }
    }
  }, [sourceLanguage, targetLanguage, toast, streamingState, isSpeechRecognitionSupported, connectWebSocket]); // Added toast, connectWebSocket to deps

  const stopRecognition = useCallback(() => {
    console.log("[Client] Tentando parar reconhecimento...");
    setStreamingState("stopping");
    if (recognition) {
      try {
        recognition.stop();
        console.log("[Client] recognition.stop() chamado.");
      } catch (e: any) {
        console.error("[Client] Erro ao chamar recognition.stop():", e);
        setStreamingState("idle"); 
      }
    } else {
       setStreamingState("idle");
    }
  }, []);

  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming chamado. Estado atual:", streamingState);
    if (streamingState === "recognizing") {
      stopRecognition();
    } else if (streamingState === "idle" || streamingState === "error") {
       if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket não está conectado. Tentando reconectar antes de iniciar o reconhecimento...");
        connectWebSocket();
      }
      startRecognition();
    }
  };
  
  useEffect(() => {
    return () => {
      if (recognition) {
        console.log("[Client] Componente desmontando, abortando SpeechRecognition se ativo.");
        recognition.abort(); 
        recognition = null;
      }
    };
  }, []);

  const StreamButtonIcon = streamingState === "recognizing" ? MicOff : Mic;
  let streamButtonText = "Iniciar Transcrição";
  if (streamingState === "recognizing") streamButtonText = "Parar Transcrição";
  if (streamingState === "stopping") streamButtonText = "Parando...";
  
  const isButtonDisabled = streamingState === "stopping";
  const isLoading = streamingState === "stopping" || isTranslating;

  const languageSelectorItems = supportedLanguages.map(lang => ({
    ...lang,
  }));


  return (
    <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-background text-foreground">
      <header className="w-full max-w-3xl mb-8 text-center">
        <div className="flex justify-center items-center mb-2">
          <LinguaVoxLogo className="h-12 w-auto" />
        </div>
        <p className="text-muted-foreground text-lg">
          Transcrição e Tradução de Áudio em Tempo Real
        </p>
      </header>

      <main className="w-full max-w-3xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Edit3 className="text-primary" />
              Transcritor e Tradutor
            </CardTitle>
            <CardDescription>
              Selecione os idiomas, inicie a transcrição e veja a tradução em tempo real.
               <br/>
              <span className="text-xs text-muted-foreground">Transcrição via API Web Speech do navegador. Tradução via servidor.</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <LanguageSelector
                id="source-language"
                label="Idioma de Origem (Fala)"
                value={sourceLanguage}
                onValueChange={(value) => {
                  if (streamingState !== "recognizing" && streamingState !== "stopping") {
                    setSourceLanguage(value);
                    console.log("[Client] Idioma Fonte alterado para:", value);
                  }
                }}
                languages={languageSelectorItems}
                disabled={streamingState === "recognizing" || streamingState === "stopping"}
              />
              <LanguageSelector
                id="target-language"
                label="Idioma de Destino (Tradução)"
                value={targetLanguage}
                onValueChange={(value) => {
                    setTargetLanguage(value);
                    console.log("[Client] Idioma Destino alterado para:", value);
                }}
                languages={languageSelectorItems}
                disabled={streamingState === "recognizing" || streamingState === "stopping"}
              />
            </div>

            <Separator />

            <div className="flex flex-col items-center space-y-4">
              <Button
                onClick={handleToggleStreaming}
                disabled={isButtonDisabled}
                className="w-full md:w-auto px-8 py-6 text-lg transition-all duration-300 ease-in-out transform hover:scale-105"
                variant={streamingState === "recognizing" ? "destructive" : "default"}
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-6 w-6 animate-spin" />
                ) : (
                  <StreamButtonIcon className="mr-2 h-6 w-6" />
                )}
                {streamButtonText}
              </Button>
              {(streamingState === "recognizing") && !isTranslating && (
                 <p className="text-sm text-primary animate-pulse">Reconhecendo fala...</p>
              )}
              {isTranslating && (
                 <p className="text-sm text-accent animate-pulse">Traduzindo...</p>
              )}
            </div>

            {error && (
              <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5"/> 
                <p>{error}</p>
              </div>
            )}
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
              <div>
                <h3 className="text-xl font-semibold font-headline mb-2 flex items-center gap-2">
                  <Mic className="text-primary"/>
                  Transcrição:
                </h3>
                <Textarea
                  value={transcribedText + (interimTranscribedText ? (transcribedText ? " " : "") + interimTranscribedText : "")}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto transcrito"
                />
              </div>
              <div>
                <h3 className="text-xl font-semibold font-headline mb-2 flex items-center gap-2">
                  <LanguagesIcon className="text-accent"/>
                  Tradução:
                </h3>
                <Textarea
                  value={translatedText}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto traduzido"
                  placeholder={isTranslating ? "Traduzindo..." : "A tradução aparecerá aqui..."}
                />
              </div>
            </div>

          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox. Todos os direitos reservados.</p>
        <p className="mt-1">Transcrição local via Web Speech API. Tradução via servidor Genkit.</p>
      </footer>
    </div>
  );
}
