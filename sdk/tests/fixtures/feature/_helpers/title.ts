// Excluded helpers must bundle when imported, without becoming API modules.
export const normalizeTitle = (title: string) => title.trim().toUpperCase();
