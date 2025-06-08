'use server';

/**
 * @fileOverview This file defines a Genkit flow for improving translation accuracy by using reasoning over a knowledge base to select terms for translation.
 *
 * - improveTranslationAccuracy - A function that initiates the translation improvement flow.
 * - ImproveTranslationAccuracyInput - The input type for the improveTranslationAccuracy function.
 * - ImproveTranslationAccuracyOutput - The return type for the improveTranslationAccuracy function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const ImproveTranslationAccuracyInputSchema = z.object({
  text: z.string().describe('The text to be translated.'),
  sourceLanguage: z.string().describe('The source language of the text.'),
  targetLanguage: z.string().describe('The target language for the translation.'),
});

export type ImproveTranslationAccuracyInput = z.infer<
  typeof ImproveTranslationAccuracyInputSchema
>;

const ImproveTranslationAccuracyOutputSchema = z.object({
  translatedText: z.string().describe('The translated text.'),
});

export type ImproveTranslationAccuracyOutput = z.infer<
  typeof ImproveTranslationAccuracyOutputSchema
>;

export async function improveTranslationAccuracy(
  input: ImproveTranslationAccuracyInput
): Promise<ImproveTranslationAccuracyOutput> {
  return improveTranslationAccuracyFlow(input);
}

const improveTranslationAccuracyPrompt = ai.definePrompt({
  name: 'improveTranslationAccuracyPrompt',
  input: {
    schema: ImproveTranslationAccuracyInputSchema,
  },
  output: {
    schema: ImproveTranslationAccuracyOutputSchema,
  },
  prompt: `You are a highly skilled translator. Your goal is to translate the given text from the source language to the target language with the highest possible accuracy.

  To achieve this, you will reason over your knowledge base to identify specific terms or phrases that might benefit from more nuanced translation. Consider cultural context, idiomatic expressions, and technical terminology.

  Source Language: {{{sourceLanguage}}}
  Target Language: {{{targetLanguage}}}
  Text to Translate: {{{text}}}

  Translation:`,
});

const improveTranslationAccuracyFlow = ai.defineFlow(
  {
    name: 'improveTranslationAccuracyFlow',
    inputSchema: ImproveTranslationAccuracyInputSchema,
    outputSchema: ImproveTranslationAccuracyOutputSchema,
  },
  async input => {
    const {output} = await improveTranslationAccuracyPrompt(input);
    return output!;
  }
);

// Export ai and z for use in other flows if necessary
export {ai as genkitAI, z as zod};
