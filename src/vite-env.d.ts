/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_V2_SEARCH_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}