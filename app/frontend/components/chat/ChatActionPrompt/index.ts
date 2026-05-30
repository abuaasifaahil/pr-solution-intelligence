/**
 * Barrel for ChatActionPrompt — re-exports the component, hook, and types
 * so callers don't dig into the folder.
 *
 * @file   ChatActionPrompt/index.ts
 * @author PR Solutions
 * @date   2026-05-30
 */
export { ChatActionPrompt } from './ChatActionPrompt';
export { useActionPrompt } from './useActionPrompt';
export type {
  ChatActionPromptProps,
  ChatActionOption,
  ChatActionInputSpec,
  ChatActionResult,
} from './types';
export { CUSTOM_OPTION_ID } from './types';
