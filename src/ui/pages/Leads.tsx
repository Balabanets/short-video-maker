import React, { useCallback, useEffect, useState } from 'react';
import { errorText, leadsApi } from '../leadsApi';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Link,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { IconButton, Tooltip } from '@mui/material';

const STATUSES = ['new', 'in_progress', 'contacted', 'subscribed', 'converted', 'rejected'] as const;
const STATUS_LABELS: Record<string, string> = {
  new: 'Новый',
  in_progress: 'В работе',
  contacted: 'Написал',
  subscribed: 'Подписался',
  converted: 'Пришёл играть',
  rejected: 'Отказ / не наш',
};
const CATEGORY_LABELS: Record<string, string> = {
  dissatisfied: 'Недоволен сервером',
  seeking: 'Ищет сервер',
  newcomer: 'Новичок',
  irrelevant: '—',
};

interface LeadComment {
  id: number;
  text: string;
  commentUrl: string | null;
  videoUrl: string;
  videoTitle: string | null;
  publishedAt: string;
  reason: string;
  mentionedServers: string[];
}

interface Lead {
  id: number;
  platform: 'youtube' | 'tiktok' | 'discord';
  authorName: string;
  authorUrl: string;
  status: string;
  notes: string;
  bestScore: number;
  bestCategory: string;
  commentCount: number;
  comments: LeadComment[];
}

interface Status {
  youtubeConfigured: boolean;
  discordConfigured: boolean;
  llmClassifier: string | null;
  scanning: boolean;
  quota: { used: number; budget: number };
}

const ago = (iso: string) => {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  if (h < 1) return 'только что';
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн. назад`;
};

const Leads: React.FC = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ status: 'new', category: '', platform: '', minScore: '40', search: '' });
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const query = useCallback(() => {
    const p = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && p.set(k, v));
    return p;
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = query();
      p.set('limit', String(rowsPerPage));
      p.set('offset', String(page * rowsPerPage));
      const [list, st] = await Promise.all([
        leadsApi.get(`/?${p}`),
        leadsApi.get('/status'),
      ]);
      setLeads(list.data.items);
      setTotal(list.data.total);
      setStatus(st.data);
      setError(null);
    } catch (e) {
      setError(`Не удалось загрузить лиды: ${errorText(e)}`);
    } finally {
      setLoading(false);
    }
  }, [query, page, rowsPerPage]);

  useEffect(() => {
    load();
  }, [load]);

  const update = async (id: number, patch: Partial<Pick<Lead, 'status' | 'notes'>>) => {
    try {
      const { data } = await leadsApi.patch(`/${id}`, patch);
      // Work-queue flow: a lead that no longer matches the status filter leaves the list.
      if (filters.status && data.status !== filters.status) {
        setLeads((ls) => ls.filter((l) => l.id !== id));
        setTotal((t) => t - 1);
      } else {
        setLeads((ls) => ls.map((l) => (l.id === id ? data : l)));
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  const downloadCsv = async () => {
    try {
      const res = await leadsApi.get(`/export.csv?${query()}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e));
    }
  };

  // While a background scan runs, poll and refresh the list when it is done.
  useEffect(() => {
    if (!status?.scanning) return;
    const t = setInterval(async () => {
      try {
        const { data } = await leadsApi.get('/status');
        if (!data.scanning) {
          clearInterval(t);
          load();
        }
      } catch {
        clearInterval(t);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [status?.scanning, load]);

  const scan = async () => {
    try {
      await leadsApi.post('/scan');
      setStatus((s) => (s ? { ...s, scanning: true } : s));
    } catch (e) {
      setError('Скан уже идёт или не настроены YOUTUBE_API_KEY / DISCORD_BOT_TOKEN');
    }
  };

  const setFilter = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setPage(0);
    setFilters((f) => ({ ...f, [k]: e.target.value }));
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h4">Лиды (холодные игроки)</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<DownloadIcon />} onClick={downloadCsv}>
            CSV
          </Button>
          <Button
            variant="contained"
            startIcon={<RefreshIcon />}
            onClick={scan}
            disabled={!(status?.youtubeConfigured || status?.discordConfigured) || status?.scanning}
          >
            {status?.scanning ? 'Сканирую…' : 'Сканировать'}
          </Button>
        </Stack>
      </Stack>

      {status && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          YouTube API: {status.youtubeConfigured ? 'подключен' : 'не настроен'} · Discord-бот:{' '}
          {status.discordConfigured ? 'подключен' : 'не настроен'} · квота YouTube сегодня{' '}
          {status.quota.used}/{status.quota.budget} · классификатор: {status.llmClassifier ?? 'правила'}
        </Typography>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <TextField select label="Статус" size="small" value={filters.status} onChange={setFilter('status')} sx={{ minWidth: 170 }}>
          <MenuItem value="">Все</MenuItem>
          {STATUSES.map((s) => (
            <MenuItem key={s} value={s}>{STATUS_LABELS[s]}</MenuItem>
          ))}
        </TextField>
        <TextField select label="Тип" size="small" value={filters.category} onChange={setFilter('category')} sx={{ minWidth: 190 }}>
          <MenuItem value="">Все</MenuItem>
          {['dissatisfied', 'seeking', 'newcomer'].map((c) => (
            <MenuItem key={c} value={c}>{CATEGORY_LABELS[c]}</MenuItem>
          ))}
        </TextField>
        <TextField select label="Площадка" size="small" value={filters.platform} onChange={setFilter('platform')} sx={{ minWidth: 140 }}>
          <MenuItem value="">Все</MenuItem>
          {['youtube', 'tiktok', 'discord'].map((p) => (
            <MenuItem key={p} value={p}>{p}</MenuItem>
          ))}
        </TextField>
        <TextField label="Мин. скор" size="small" type="number" value={filters.minScore} onChange={setFilter('minScore')} sx={{ width: 110 }} />
        <TextField label="Поиск" size="small" value={filters.search} onChange={setFilter('search')} sx={{ flexGrow: 1 }} />
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Профиль</TableCell>
              <TableCell>Комментарий</TableCell>
              <TableCell>Скор</TableCell>
              <TableCell sx={{ minWidth: 170 }}>Статус</TableCell>
              <TableCell sx={{ minWidth: 200 }}>Заметки</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={5} align="center"><CircularProgress size={24} /></TableCell>
              </TableRow>
            )}
            {!loading && leads.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} align="center">Пока пусто — создайте кампанию и запустите скан.</TableCell>
              </TableRow>
            )}
            {!loading &&
              leads.map((lead) => {
                const c = lead.comments[0];
                return (
                  <TableRow key={lead.id} hover>
                    <TableCell>
                      <Link href={lead.authorUrl} target="_blank" rel="noopener noreferrer">{lead.authorName}</Link>
                      <Box><Chip size="small" label={lead.platform} sx={{ mt: 0.5 }} /></Box>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 480 }}>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{c?.text}</Typography>
                      <Typography variant="caption" color="text.secondary" component="div">
                        {CATEGORY_LABELS[lead.bestCategory]} · {c?.reason}
                        {c?.mentionedServers.length ? ` · сервера: ${c.mentionedServers.join(', ')}` : ''}
                      </Typography>
                      <Typography variant="caption" component="div">
                        <Link href={c?.commentUrl ?? c?.videoUrl} target="_blank" rel="noopener noreferrer">
                          открыть комментарий <OpenInNewIcon sx={{ fontSize: 12 }} />
                        </Link>{' '}
                        · {c?.videoTitle ?? 'видео'} · {c ? ago(c.publishedAt) : ''}
                        {lead.commentCount > 1 ? ` · ещё ${lead.commentCount - 1} коммент.` : ''}
                      </Typography>
                    </TableCell>
                    <TableCell>{lead.bestScore}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} sx={{ mb: 0.5 }}>
                        <Tooltip title="Написал ему">
                          <IconButton size="small" color="success" onClick={() => update(lead.id, { status: 'contacted' })}>
                            <CheckIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Не лид">
                          <IconButton size="small" color="error" onClick={() => update(lead.id, { status: 'rejected' })}>
                            <CloseIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                      <TextField
                        select
                        size="small"
                        fullWidth
                        value={lead.status}
                        onChange={(e) => update(lead.id, { status: e.target.value })}
                      >
                        {STATUSES.map((s) => (
                          <MenuItem key={s} value={s}>{STATUS_LABELS[s]}</MenuItem>
                        ))}
                      </TextField>
                    </TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        fullWidth
                        multiline
                        defaultValue={lead.notes}
                        onBlur={(e) => e.target.value !== lead.notes && update(lead.id, { notes: e.target.value })}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
        <TablePagination
          component="div"
          count={total}
          page={page}
          onPageChange={(_e, p) => setPage(p)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(e) => {
            setRowsPerPage(parseInt(e.target.value, 10));
            setPage(0);
          }}
          labelRowsPerPage="На странице"
        />
      </TableContainer>
    </Box>
  );
};

export default Leads;
