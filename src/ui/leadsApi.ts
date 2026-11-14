import axios, { AxiosError, AxiosRequestConfig } from 'axios';

/**
 * Axios instance for /api/leads. If the server requires LEAD_FINDER_API_TOKEN, the page asks
 * for it once and keeps it in this browser.
 */
const TOKEN_KEY = 'leadFinderToken';

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export const leadsApi = axios.create({ baseURL: '/api/leads' });

leadsApi.interceptors.request.use((config) => {
  const token = readToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

leadsApi.interceptors.response.use(undefined, async (error: AxiosError) => {
  const config = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
  if (error.response?.status === 401 && config && !config._retried) {
    const token = window.prompt('API лидов защищено токеном. Введите LEAD_FINDER_API_TOKEN:');
    if (token) {
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* private mode: token works for this request only */
      }
      config._retried = true;
      config.headers = { ...(config.headers ?? {}), Authorization: `Bearer ${token}` };
      return leadsApi.request(config);
    }
  }
  return Promise.reject(error);
});

export const errorText = (e: unknown): string => {
  const err = e as AxiosError<{ error?: string; issues?: { path: (string | number)[]; message: string }[] }>;
  const data = err.response?.data;
  if (data?.issues?.length) {
    return data.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  }
  return data?.error ?? err.message ?? 'ошибка';
};
