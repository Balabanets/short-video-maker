import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Grid,
  Link,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { errorText, leadsApi } from '../leadsApi';

interface Campaign {
  id: number;
  name: string;
  game: string;
  queries: string[];
  channelIds: string[];
  videoIds: string[];
  discordGuildIds: string[];
  discordChannelIds: string[];
  discordExcludeChannelIds: string[];
  competitorNames: string[];
  ownServerName?: string;
  extraKeywords: string[];
  language: string;
  regionCode?: string;
  publishedWithinDays: number;
  maxCommentAgeDays: number;
  maxVideosPerQuery: number;
  minScore: number;
  enabled: boolean;
  lastRunAt: string | null;
}

interface ScanReport {
  campaignId: number | null;
  startedAt: string;
  finishedAt: string;
  videosScanned: number;
  discordChannelsScanned: number;
  commentsRead: number;
  leadsFound: number;
  newLeads: number;
  quotaUnitsUsed: number;
  errors: string[];
}

interface Status {
  youtubeConfigured: boolean;
  discordConfigured: boolean;
  llmClassifier: string | null;
  llmUsage: { requests: number; inputTokens: number; outputTokens: number } | null;
  telegramNotifications: { minScore: number } | null;
  scanning: boolean;
  scheduleMinutes: number;
  quota: { used: number; budget: number };
}

interface DiscordOverview {
  bot: string;
  inviteUrl: string;
  guilds: { id: string; name: string; channels: { id: string; name: string; type: number }[] }[];
}

interface Stats {
  signalQuality: { signal: string; leads: number; worked: number; rejected: number; positive: number }[];
  topMentionedServers: { server: string; n: number }[];
  topVideos: { videoUrl: string; title: string; channel: string; leads: number }[];
  byCampaign: { name: string; leads: number; positive: number }[];
}

type Form = Record<
  | 'name' | 'game' | 'queries' | 'channelIds' | 'videoIds' | 'competitorNames' | 'ownServerName'
  | 'extraKeywords' | 'language' | 'regionCode' | 'publishedWithinDays' | 'maxCommentAgeDays'
  | 'maxVideosPerQuery' | 'minScore' | 'discordGuildIds' | 'discordChannelIds' | 'discordExcludeChannelIds',
  string
> & { enabled: boolean };

const EMPTY: Form = {
  name: '',
  game: '',
  queries: '',
  channelIds: '',
  videoIds: '',
  competitorNames: '',
  ownServerName: '',
  extraKeywords: '',
  language: 'ru',
  regionCode: '',
  publishedWithinDays: '30',
  maxCommentAgeDays: '60',
  maxVideosPerQuery: '15',
  minScore: '40',
  discordGuildIds: '',
  discordChannelIds: '',
  discordExcludeChannelIds: '',
  enabled: true,
};

const byLine = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const toForm = (c: Campaign): Form => ({
  name: c.name,
  game: c.game,
  queries: c.queries.join('\n'),
  channelIds: c.channelIds.join('\n'),
  videoIds: c.videoIds.join('\n'),
  competitorNames: c.competitorNames.join(', '),
  ownServerName: c.ownServerName ?? '',
  extraKeywords: c.extraKeywords.join('\n'),
  language: c.language,
  regionCode: c.regionCode ?? '',
  publishedWithinDays: String(c.publishedWithinDays),
  maxCommentAgeDays: String(c.maxCommentAgeDays),
  maxVideosPerQuery: String(c.maxVideosPerQuery),
  minScore: String(c.minScore),
  discordGuildIds: c.discordGuildIds.join('\n'),
  discordChannelIds: c.discordChannelIds.join('\n'),
  discordExcludeChannelIds: c.discordExcludeChannelIds.join('\n'),
  enabled: c.enabled,
});
const toPayload = (f: Form) => ({
  name: f.name.trim(),
  game: f.game.trim(),
  queries: byLine(f.queries),
  channelIds: lines(f.channelIds),
  videoIds: lines(f.videoIds),
  competitorNames: lines(f.competitorNames),
  ownServerName: f.ownServerName.trim() || undefined,
  extraKeywords: byLine(f.extraKeywords),
  language: f.language.trim() || 'ru',
  regionCode: f.regionCode.trim().toUpperCase() || undefined,
  publishedWithinDays: Number(f.publishedWithinDays),
  maxCommentAgeDays: Number(f.maxCommentAgeDays),
  maxVideosPerQuery: Number(f.maxVideosPerQuery),
  minScore: Number(f.minScore),
  discordGuildIds: lines(f.discordGuildIds),
  discordChannelIds: lines(f.discordChannelIds),
  discordExcludeChannelIds: lines(f.discordExcludeChannelIds),
  enabled: f.enabled,
});

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString('ru-RU') : '—');
const quotaCost = (c: Campaign) => c.queries.length * 100 + c.channelIds.length * 2;

const Campaigns: React.FC = () => {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [scans, setScans] = useState<ScanReport[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [scanningId, setScanningId] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number | null; form: Form } | null>(null);
  const [saving, setSaving] = useState(false);
  const [discord, setDiscord] = useState<DiscordOverview | null>(null);
  const [discordLoading, setDiscordLoading] = useState(false);
  const [openScan, setOpenScan] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, s, st, stt] = await Promise.all([
        leadsApi.get('/campaigns'),
        leadsApi.get('/scans'),
        leadsApi.get('/status'),
        leadsApi.get('/stats'),
      ]);
      setCampaigns(c.data.campaigns);
      setScans(s.data.scans);
      setStatus(st.data);
      setStats(stt.data);
      setError(null);
    } catch (e) {
      setError(`Не удалось загрузить данные: ${errorText(e)}`);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const scan = async (c: Campaign) => {
    setScanningId(c.id);
    setNotice(null);
    try {
      const { data } = await leadsApi.post<ScanReport>(`/campaigns/${c.id}/scan`);
      setNotice({
        text:
          `«${c.name}»: прочитано ${data.commentsRead}, новых лидов ${data.newLeads}` +
          (data.errors.length ? `. Ошибок: ${data.errors.length} — ${data.errors[0]}` : ''),
        ok: data.errors.length === 0,
      });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setScanningId(null);
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const payload = toPayload(editing.form);
      if (editing.id) await leadsApi.put(`/campaigns/${editing.id}`, payload);
      else await leadsApi.post('/campaigns', payload);
      setEditing(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (c: Campaign) => {
    await leadsApi.put(`/campaigns/${c.id}`, { ...toPayload(toForm(c)), enabled: !c.enabled });
    load();
  };

  const remove = async (c: Campaign) => {
    if (!window.confirm(`Удалить кампанию «${c.name}»? Найденные лиды останутся.`)) return;
    await leadsApi.delete(`/campaigns/${c.id}`);
    load();
  };

  const loadDiscord = async () => {
    setDiscordLoading(true);
    try {
      setDiscord((await leadsApi.get('/discord')).data);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDiscordLoading(false);
    }
  };

  const testTelegram = async () => {
    try {
      await leadsApi.post('/notify/test');
      setNotice({ text: 'Тестовое сообщение отправлено в Telegram', ok: true });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const setField = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setEditing((ed) => (ed ? { ...ed, form: { ...ed.form, [k]: e.target.value } } : ed));

  const toggleId = (k: 'discordGuildIds' | 'discordChannelIds', id: string) =>
    setEditing((ed) => {
      if (!ed) return ed;
      const ids = new Set(lines(ed.form[k]));
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ...ed, form: { ...ed.form, [k]: [...ids].join('\n') } };
    });

  const campaignName = (id: number | null) => campaigns.find((c) => c.id === id)?.name ?? 'импорт';
  const f = editing?.form;
  const field = (k: keyof Form, label: string, props: Record<string, unknown> = {}) => (
    <TextField fullWidth size="small" label={label} value={f?.[k] ?? ''} onChange={setField(k)} {...props} />
  );

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h4">Кампании поиска</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({ id: null, form: EMPTY })}>
          Новая кампания
        </Button>
      </Stack>

      {status && (
        <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
          <Chip color={status.youtubeConfigured ? 'success' : 'default'} label={`YouTube: ${status.youtubeConfigured ? `квота ${status.quota.used}/${status.quota.budget}` : 'нет ключа'}`} />
          <Chip color={status.discordConfigured ? 'success' : 'default'} label={`Discord-бот: ${status.discordConfigured ? 'подключен' : 'нет токена'}`} />
          <Chip
            color={status.llmClassifier ? 'success' : 'default'}
            label={
              status.llmClassifier
                ? `Claude: ${status.llmClassifier}, токенов ${((status.llmUsage?.inputTokens ?? 0) + (status.llmUsage?.outputTokens ?? 0)).toLocaleString('ru-RU')}`
                : 'Claude: выключен (только словарь)'
            }
          />
          <Chip
            color={status.telegramNotifications ? 'success' : 'default'}
            label={status.telegramNotifications ? `Telegram: от ${status.telegramNotifications.minScore} баллов` : 'Telegram: выключен'}
            onClick={status.telegramNotifications ? testTelegram : undefined}
          />
          <Chip label={status.scheduleMinutes ? `Автоскан каждые ${status.scheduleMinutes} мин` : 'Автоскан выключен'} />
        </Stack>
      )}

      {error && <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>{error}</Alert>}
      {notice && (
        <Alert severity={notice.ok ? 'success' : 'warning'} onClose={() => setNotice(null)} sx={{ mb: 2 }}>
          {notice.text}
        </Alert>
      )}

      {campaigns.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Кампаний пока нет. Создайте первую: укажите игру, 2–5 поисковых запросов и каналы конкурентов или обзорщиков.
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 4 }}>
        {campaigns.map((c) => (
          <Grid item xs={12} md={6} key={c.id}>
            <Card variant="outlined" sx={{ opacity: c.enabled ? 1 : 0.6 }}>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="h6">{c.name}</Typography>
                  <FormControlLabel control={<Switch checked={c.enabled} onChange={() => toggle(c)} />} label={c.enabled ? 'вкл' : 'выкл'} />
                </Stack>
                <Typography variant="body2" color="text.secondary">{c.game}</Typography>
                <Stack direction="row" spacing={1} sx={{ my: 1, flexWrap: 'wrap', rowGap: 1 }}>
                  {c.queries.length > 0 && <Chip size="small" label={`запросов: ${c.queries.length}`} />}
                  {c.channelIds.length > 0 && <Chip size="small" label={`каналов: ${c.channelIds.length}`} />}
                  {c.videoIds.length > 0 && <Chip size="small" label={`видео: ${c.videoIds.length}`} />}
                  {c.discordGuildIds.length + c.discordChannelIds.length > 0 && (
                    <Chip size="small" label={`Discord: ${c.discordGuildIds.length} серв., ${c.discordChannelIds.length} кан.`} />
                  )}
                  <Chip size="small" variant="outlined" label={`мин. скор ${c.minScore}`} />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Последний скан: {fmtDate(c.lastRunAt)} · ≈{quotaCost(c)} ед. квоты YouTube на поиск за скан
                </Typography>
              </CardContent>
              <CardActions>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={scanningId === c.id ? <CircularProgress size={14} color="inherit" /> : <PlayArrowIcon />}
                  disabled={scanningId !== null || status?.scanning}
                  onClick={() => scan(c)}
                >
                  {scanningId === c.id ? 'Сканирую…' : 'Сканировать'}
                </Button>
                <Button size="small" startIcon={<EditIcon />} onClick={() => setEditing({ id: c.id, form: toForm(c) })}>Изменить</Button>
                <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => remove(c)}>Удалить</Button>
              </CardActions>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Typography variant="h5" sx={{ mb: 1 }}>История сканов</Typography>
      <Table size="small" sx={{ mb: 4 }}>
        <TableHead>
          <TableRow>
            <TableCell>Когда</TableCell>
            <TableCell>Кампания</TableCell>
            <TableCell align="right">Видео / Discord</TableCell>
            <TableCell align="right">Прочитано</TableCell>
            <TableCell align="right">Новых лидов</TableCell>
            <TableCell align="right">Квота</TableCell>
            <TableCell>Ошибки</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {scans.length === 0 && (
            <TableRow><TableCell colSpan={7}>Сканов ещё не было</TableCell></TableRow>
          )}
          {scans.map((s, i) => (
            <React.Fragment key={i}>
              <TableRow hover onClick={() => setOpenScan(openScan === i ? null : i)} sx={{ cursor: s.errors.length ? 'pointer' : 'default' }}>
                <TableCell>{fmtDate(s.startedAt)}</TableCell>
                <TableCell>{campaignName(s.campaignId)}</TableCell>
                <TableCell align="right">{s.videosScanned} / {s.discordChannelsScanned ?? 0}</TableCell>
                <TableCell align="right">{s.commentsRead}</TableCell>
                <TableCell align="right"><b>{s.newLeads}</b></TableCell>
                <TableCell align="right">{s.quotaUnitsUsed}</TableCell>
                <TableCell>{s.errors.length ? <Chip size="small" color="warning" label={`${s.errors.length} — показать`} /> : '—'}</TableCell>
              </TableRow>
              {s.errors.length > 0 && (
                <TableRow>
                  <TableCell colSpan={7} sx={{ py: 0, borderBottom: openScan === i ? undefined : 'none' }}>
                    <Collapse in={openScan === i}>
                      <Box component="ul" sx={{ my: 1 }}>
                        {s.errors.map((e, k) => <li key={k}><Typography variant="caption">{e}</Typography></li>)}
                      </Box>
                    </Collapse>
                  </TableCell>
                </TableRow>
              )}
            </React.Fragment>
          ))}
        </TableBody>
      </Table>

      {stats && (
        <>
          <Typography variant="h5" sx={{ mb: 1 }}>Что работает</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Отмечайте лидов «Написал» или «Не лид» на странице Leads. Здесь видно, какие сигналы приводят живых людей,
            а какие дают мусор: такие стоит убрать или поднять мин. скор.
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Сигнал</TableCell>
                    <TableCell align="right">Лидов</TableCell>
                    <TableCell align="right">Обработано</TableCell>
                    <TableCell align="right">Не лид</TableCell>
                    <TableCell align="right">Удачно</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {stats.signalQuality.map((q) => (
                    <TableRow key={q.signal}>
                      <TableCell>{q.signal}</TableCell>
                      <TableCell align="right">{q.leads}</TableCell>
                      <TableCell align="right">{q.worked}</TableCell>
                      <TableCell align="right" sx={{ color: q.worked >= 5 && q.rejected / q.worked > 0.5 ? 'error.main' : undefined }}>{q.rejected}</TableCell>
                      <TableCell align="right">{q.positive}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Grid>
            <Grid item xs={12} md={6}>
              <Typography variant="subtitle2">Какие сервера ругают</Typography>
              <Stack direction="row" spacing={1} sx={{ my: 1, flexWrap: 'wrap', rowGap: 1 }}>
                {stats.topMentionedServers.length === 0 && <Typography variant="body2" color="text.secondary">Добавьте названия конкурентов в кампанию</Typography>}
                {stats.topMentionedServers.map((s) => <Chip key={s.server} label={`${s.server}: ${s.n}`} />)}
              </Stack>
              <Typography variant="subtitle2" sx={{ mt: 2 }}>Видео и каналы, где больше всего лидов</Typography>
              <Box component="ol" sx={{ pl: 3, mt: 1 }}>
                {stats.topVideos.slice(0, 8).map((v) => (
                  <li key={v.videoUrl}>
                    <Typography variant="body2">
                      <Link href={v.videoUrl} target="_blank" rel="noopener noreferrer">{v.title || v.videoUrl}</Link>
                      {v.channel ? ` — ${v.channel}` : ''} · {v.leads}
                    </Typography>
                  </li>
                ))}
              </Box>
            </Grid>
          </Grid>
        </>
      )}

      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)} maxWidth="md" fullWidth>
        <DialogTitle>{editing?.id ? 'Изменить кампанию' : 'Новая кампания'}</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>{field('name', 'Название кампании', { required: true })}</Grid>
            <Grid item xs={12} sm={6}>{field('game', 'Игра / тип серверов', { required: true, placeholder: 'GTA 5 RP' })}</Grid>

            <Grid item xs={12}><Divider textAlign="left"><Typography variant="overline">YouTube</Typography></Divider></Grid>
            <Grid item xs={12} sm={6}>
              {field('queries', 'Поисковые запросы (по строке)', { multiline: true, minRows: 3, placeholder: 'лучший сервер гта 5 рп\nкакой сервер выбрать гта рп', helperText: 'каждый запрос = 100 ед. квоты за скан' })}
            </Grid>
            <Grid item xs={12} sm={6}>
              {field('channelIds', 'Каналы конкурентов и обзорщиков', { multiline: true, minRows: 3, placeholder: '@channel или ссылка', helperText: '2 ед. квоты на канал — самый выгодный источник' })}
            </Grid>
            <Grid item xs={12}>
              {field('videoIds', 'Конкретные видео (ссылки)', { multiline: true, minRows: 2 })}
            </Grid>

            <Grid item xs={12}><Divider textAlign="left"><Typography variant="overline">Discord</Typography></Divider></Grid>
            <Grid item xs={12}>
              {!status?.discordConfigured ? (
                <Alert severity="info">Задайте DISCORD_BOT_TOKEN, чтобы читать Discord-серверы, куда пригласили вашего бота.</Alert>
              ) : (
                <Box>
                  <Button size="small" onClick={loadDiscord} disabled={discordLoading}>
                    {discordLoading ? 'Загружаю…' : discord ? 'Обновить список серверов' : 'Показать серверы бота'}
                  </Button>
                  {discord && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="body2">
                        Ссылка для админов серверов-партнёров:{' '}
                        <Link href={discord.inviteUrl} target="_blank" rel="noopener noreferrer">пригласить «{discord.bot}»</Link>
                      </Typography>
                      {discord.guilds.length === 0 && <Typography variant="body2" color="text.secondary">Бот пока ни на одном сервере.</Typography>}
                      {discord.guilds.map((g) => {
                        const wholeGuild = lines(f?.discordGuildIds ?? '').includes(g.id);
                        return (
                          <Box key={g.id} sx={{ mt: 1 }}>
                            <FormControlLabel
                              control={<Checkbox checked={wholeGuild} onChange={() => toggleId('discordGuildIds', g.id)} />}
                              label={<b>{g.name} — весь сервер</b>}
                            />
                            {!wholeGuild && (
                              <Box sx={{ pl: 4, display: 'flex', flexWrap: 'wrap' }}>
                                {g.channels.map((ch) => (
                                  <FormControlLabel
                                    key={ch.id}
                                    control={<Checkbox size="small" checked={lines(f?.discordChannelIds ?? '').includes(ch.id)} onChange={() => toggleId('discordChannelIds', ch.id)} />}
                                    label={`#${ch.name}`}
                                  />
                                ))}
                              </Box>
                            )}
                          </Box>
                        );
                      })}
                    </Box>
                  )}
                </Box>
              )}
            </Grid>
            <Grid item xs={12} sm={4}>{field('discordGuildIds', 'ID серверов', { multiline: true, minRows: 2 })}</Grid>
            <Grid item xs={12} sm={4}>{field('discordChannelIds', 'ID каналов', { multiline: true, minRows: 2 })}</Grid>
            <Grid item xs={12} sm={4}>{field('discordExcludeChannelIds', 'Исключить каналы (ID)', { multiline: true, minRows: 2, helperText: '#правила, #staff, мемы' })}</Grid>

            <Grid item xs={12}><Divider textAlign="left"><Typography variant="overline">Фильтры</Typography></Divider></Grid>
            <Grid item xs={12} sm={6}>{field('competitorNames', 'Сервера-конкуренты (через запятую)', { placeholder: 'Majestic, Arizona, Radmir' })}</Grid>
            <Grid item xs={12} sm={6}>{field('ownServerName', 'Ваш сервер (его игроков не трогаем)')}</Grid>
            <Grid item xs={12}>{field('extraKeywords', 'Свои фразы-сигналы (по строке)', { multiline: true, minRows: 2, placeholder: 'семья ищет игроков' })}</Grid>
            <Grid item xs={6} sm={2}>{field('language', 'Язык')}</Grid>
            <Grid item xs={6} sm={2}>{field('regionCode', 'Регион', { placeholder: 'RU' })}</Grid>
            <Grid item xs={6} sm={2}>{field('publishedWithinDays', 'Видео не старше, дн.', { type: 'number' })}</Grid>
            <Grid item xs={6} sm={2}>{field('maxCommentAgeDays', 'Комменты не старше, дн.', { type: 'number' })}</Grid>
            <Grid item xs={6} sm={2}>{field('maxVideosPerQuery', 'Видео на запрос', { type: 'number' })}</Grid>
            <Grid item xs={6} sm={2}>{field('minScore', 'Мин. скор', { type: 'number', helperText: '40 — норм, 60 — строже' })}</Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)}>Отмена</Button>
          <Button variant="contained" onClick={save} disabled={saving || !f?.name.trim() || !f?.game.trim()}>
            Сохранить
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Campaigns;
