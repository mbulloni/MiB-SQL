/// <reference types="vite/client" />

declare module 'monaco-editor/languages/definitions/mysql/mysql' {
  export const language: { keywords: string[]; operators: string[]; builtinFunctions: string[] };
}

declare const __APP_VERSION__: string;
