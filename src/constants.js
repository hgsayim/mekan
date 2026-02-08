/**
 * Uygulama sabitleri ve debug yardımcıları
 */

export const DEBUG_MODE = false;

export const debugLog = (...args) => {
  if (DEBUG_MODE) console.log(...args);
};

export const debugWarn = (...args) => {
  if (DEBUG_MODE) console.warn(...args);
};
