
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, MicOff, Loader2, AlertTriangle, Edit3 } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages } from "@/lib/languages";
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";

type StreamingState = "idle" | "recognizing" | "error" | "stopping";

// Variável global para SpeechRecognition para evitar múltiplas instâncias
let recognition: SpeechRecognition | null = null;

export default function LinguaVoxPage() {
  const [sourceLanguage, setSourceLanguage] = useState<string>("pt-BR"); // Default para pt-BR para Web Speech API
  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const [transcribedText, setTranscribedText] = useState<string>("");
  const [interimTranscribedText, setInterimTranscribedText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const { toast } = useToast();

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
    if (!isSpeechRecognitionSupported()) {
      setError("Reconhecimento de fala não suportado.");
      setStreamingState("error");
      return;
    }

    if (streamingState === "recognizing") {
      console.warn("[Client] Tentativa de iniciar reconhecimento já em progresso.");
      return;
    }

    setStreamingState("recognizing");
    setError(null);
    setTranscribedText("");
    setInterimTranscribedText("");
    toast({ title: "Microfone Ativado", description: "Iniciando reconhecimento de fala..." });

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
        setError("API de Reconhecimento de Fala não encontrada no navegador.");
        setStreamingState("error");
        return;
    }
    
    recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = sourceLanguage;

    console.log(`[Client] Iniciando SpeechRecognition com idioma: ${sourceLanguage}`);

    recognition.onstart = () => {
      console.log("[Client] SpeechRecognition iniciado.");
      setStreamingState("recognizing");
    };

    let finalTranscriptProcessedLength = 0;

    recognition.onresult = (event) => {
      let interim = "";
      let final = transcribedText; // Começa com o texto final já acumulado

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          const newFinalChunk = event.results[i][0].transcript;
          // Adiciona apenas a nova parte final
          final += (final ? " " : "") + newFinalChunk.substring(finalTranscriptProcessedLength > 0 ? 0 : 0); // Se precisar de lógica mais complexa para evitar duplicação
          finalTranscriptProcessedLength = newFinalChunk.length; // Atualiza o comprimento processado (simplificado)
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      
      setTranscribedText(final);
      setInterimTranscribedText(interim);
    };

    recognition.onerror = (event) => {
      console.error("[Client] Erro no SpeechRecognition:", event.error);
      let errMessage = `Erro no reconhecimento: ${event.error}`;
      if (event.error === 'network') {
        errMessage = "Erro de rede durante o reconhecimento. Verifique sua conexão.";
      } else if (event.error === 'no-speech') {
        errMessage = "Nenhuma fala detectada. Tente falar mais alto ou verifique o microfone.";
      } else if (event.error === 'audio-capture') {
        errMessage = "Falha na captura de áudio. Verifique as permissões do microfone.";
      } else if (event.error === 'not-allowed') {
        errMessage = "Permissão para usar o microfone negada ou não solicitada.";
      } else if (event.error === 'language-not-supported') {
        errMessage = `O idioma ${sourceLanguage} não é suportado pelo reconhecimento de fala do seu navegador.`;
      }
      setError(errMessage);
      setStreamingState("error");
      toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      if (recognition && streamingState === "recognizing") {
        recognition.stop();
      }
    };

    recognition.onend = () => {
      console.log("[Client] SpeechRecognition finalizado.");
      // Só muda para idle se não foi um erro que já mudou o estado
      if (streamingState === "recognizing" || streamingState === "stopping") {
        setStreamingState("idle");
        setInterimTranscribedText(""); // Limpa interino ao finalizar
      }
      finalTranscriptProcessedLength = 0; // Reseta para a próxima sessão
    };

    recognition.start();

  }, [sourceLanguage, toast, isSpeechRecognitionSupported, streamingState, transcribedText]);

  const stopRecognition = useCallback(() => {
    console.log("[Client] Parando reconhecimento de fala...");
    setStreamingState("stopping");
    if (recognition) {
      recognition.stop();
    }
    // O onend do recognition vai setar o estado para "idle"
  }, []);

  const handleToggleStreaming = () => {
    if (streamingState === "recognizing") {
      stopRecognition();
    } else if (streamingState === "idle" || streamingState === "error") {
      // Se estiver em erro, permite tentar iniciar novamente (após o usuário corrigir o problema)
      startRecognition();
    }
  };
  
  useEffect(() => {
    // Cleanup no unmount
    return () => {
      if (recognition) {
        console.log("[Client] Componente desmontando, parando SpeechRecognition se ativo.");
        recognition.abort(); // Abortar para interromper imediatamente
        recognition = null;
      }
    };
  }, []);


  const StreamButtonIcon = streamingState === "recognizing" ? MicOff : Mic;
  let streamButtonText = "Iniciar Transcrição";
  if (streamingState === "recognizing") streamButtonText = "Parar Transcrição";
  if (streamingState === "stopping") streamButtonText = "Parando...";
  
  const isButtonDisabled = streamingState === "stopping" || (streamingState === "error" && !isSpeechRecognitionSupported());
  const isLoading = streamingState === "stopping";

  return (
    <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-background text-foreground">
      <header className="w-full max-w-3xl mb-8 text-center">
        <div className="flex justify-center items-center mb-2">
          <LinguaVoxLogo className="h-12 w-auto" />
        </div>
        <p className="text-muted-foreground text-lg">
          Transcrição de Áudio em Tempo Real (no Navegador)
        </p>
      </header>

      <main className="w-full max-w-3xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Edit3 className="text-primary" />
              Transcritor de Fala (Local)
            </CardTitle>
            <CardDescription>
              Selecione o idioma de origem e inicie para transcrição em tempo real usando a API Web Speech do seu navegador.
               <br/>
              <span className="text-xs text-muted-foreground">Nota: A qualidade e suporte a idiomas dependem do seu navegador.</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-1 gap-6">
              <LanguageSelector
                id="source-language"
                label="Idioma de Origem da Fala"
                value={sourceLanguage}
                onValueChange={(value) => {
                  if (streamingState !== "recognizing") {
                    setSourceLanguage(value);
                  }
                }}
                languages={supportedLanguages.map(lang => ({
                    ...lang,
                    // Adapta códigos para o formato esperado pela Web Speech API (ex: 'en-US')
                    // Esta é uma simplificação, pode ser necessário mapeamento mais robusto
                    code: lang.code === "en" ? "en-US" : 
                          lang.code === "es" ? "es-ES" :
                          lang.code === "fr" ? "fr-FR" :
                          lang.code === "de" ? "de-DE" :
                          lang.code === "it" ? "it-IT" :
                          lang.code === "pt" ? "pt-BR" :
                          lang.code // fallback
                }))}
                disabled={streamingState === "recognizing"}
              />
            </div>

            <Separator />

            <div className="flex flex-col items-center space-y-4">
              <Button
                onClick={handleToggleStreaming}
                disabled={isButtonDisabled || !isSpeechRecognitionSupported()}
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
              {(streamingState === "recognizing") && (
                 <p className="text-sm text-primary animate-pulse">Reconhecendo fala...</p>
              )}
            </div>

            {error && (
              <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5"/> 
                <p>{error}</p>
              </div>
            )}
            
            {(transcribedText || interimTranscribedText) && (
              <div className="mt-6 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="text-xl font-semibold font-headline">Transcrição:</h3>
                </div>
                <Textarea
                  value={transcribedText + (interimTranscribedText ? (transcribedText ? " " : "") + interimTranscribedText : "")}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto transcrito"
                />
              </div>
            )}
          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox. Todos os direitos reservados.</p>
        <p className="mt-1">Transcrição de áudio local usando a API Web Speech do navegador.</p>
      </footer>
    </div>
  );
}

    