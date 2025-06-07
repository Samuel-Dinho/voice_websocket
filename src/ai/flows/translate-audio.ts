
'use server';

/**
 * @fileOverview Real-time audio translation flow.
 *
 * - translateAudio - A function that handles the audio transcription (and eventually translation) process.
 * - TranslateAudioInput - The input type for the translateAudio function.
 * - TranslateAudioOutput - The return type for the translateAudio function (will only contain transcribed text for now).
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';
import { GoogleGenerativeAIFetchError } from '@google/generative-ai'; // Correct import

const TranslateAudioInputSchema = z.object({
  audioDataUri: z
    .string()
    .describe(
      "The audio data as a data URI that must include a MIME type and use Base64 encoding. Expected format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
  sourceLanguage: z.string().describe('The language of the audio to be transcribed.'),
  targetLanguage: z.string().describe('The language to translate the transcribed text to (currently unused).'),
});
export type TranslateAudioInput = z.infer<typeof TranslateAudioInputSchema>;

// Temporarily, output will only be transcribed text for debugging
const TranslateAudioOutputSchema = z.object({
  translatedText: z.string().describe('The transcribed text of the audio (translation step removed for debugging).'),
});
export type TranslateAudioOutput = z.infer<typeof TranslateAudioOutputSchema>;


export async function translateAudio(input: TranslateAudioInput): Promise<TranslateAudioOutput> {
  console.log(`[translateAudio Flow Invoked] Input audioDataUri (start): ${input.audioDataUri.substring(0, 100)}...`);
  return translateAudioFlow(input);
}

const translateAudioFlow = ai.defineFlow(
  {
    name: 'translateAudioFlow',
    inputSchema: TranslateAudioInputSchema,
    outputSchema: TranslateAudioOutputSchema,
  },
  async (input: TranslateAudioInput) => {
    console.log(`[translateAudioFlow] Processing input. audioDataUri (start): ${input.audioDataUri.substring(0, 200)}...`);
    
    try {
      // Step 1: Transcribe audio to text
      console.log(`[translateAudioFlow] Step 1: Attempting to transcribe audio from ${input.sourceLanguage}. audioDataUri (length: ${input.audioDataUri.length}, start: ${input.audioDataUri.substring(0,60)}...)`);
      
      const transcriptionPromptParts = [
        {text: `You are an audio transcription expert. Transcribe the following audio from ${input.sourceLanguage}. Provide only the transcribed text.`},
        {media: {url: input.audioDataUri}},
        {text: "Transcription:"}
      ];

      // console.log('[translateAudioFlow] Transcription prompt parts:', JSON.stringify(transcriptionPromptParts, null, 2));

      const transcriptionResponse = await ai.generate({
        prompt: transcriptionPromptParts,
        config: { 
          temperature: 0.3, 
          safetySettings: [ 
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          ]
        }
      });

      const transcribedText = transcriptionResponse.text?.trim();
      console.log(`[translateAudioFlow] Raw transcription response text: "${transcribedText}"`);
      // console.log('[translateAudioFlow] Full transcription response object:', JSON.stringify(transcriptionResponse, null, 2));


      if (!transcribedText) {
          console.warn('[translateAudioFlow] Transcription step returned no text or empty text. Returning empty.');
          // Retornar um texto que indique falha na transcrição, mas não quebre o fluxo
          return { translatedText: `[Transcription Error: No text returned for ${input.sourceLanguage}]` };
      }

      // Step 2: Translate transcribed text (TEMPORARILY REMOVED FOR DEBUGGING)
      // For now, just return the transcribed text as "translatedText"
      console.log(`[translateAudioFlow] Transcription successful. Text: "${transcribedText}". Translation step skipped for debugging.`);
      return { translatedText: `[Transcribed ${input.sourceLanguage}]: ${transcribedText}` };

    } catch (error: any) {
        console.error('[translateAudioFlow] Error during ai.generate (transcription):', error.message);
        if (error instanceof GoogleGenerativeAIFetchError) { // Check if it's the specific error type
          console.error('[translateAudioFlow] GoogleGenerativeAIFetchError Details:', {
            status: error.status,
            statusText: error.statusText,
            message: error.message, // Already logged above
            errorDetails: error.errorDetails, 
            traceId: (error as any).traceId 
          });
        } else {
          console.error('[translateAudioFlow] Non-GoogleGenerativeAIFetchError Details:', error);
        }
        // Re-throw the original error to be caught by the WebSocket server
        // This ensures the client gets an error message if the flow truly fails.
        throw error; 
    }
  }
);
