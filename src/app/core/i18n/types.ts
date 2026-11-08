import { es } from '@core/i18n/locales/es';

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
export type Translations = Widen<typeof es>;
