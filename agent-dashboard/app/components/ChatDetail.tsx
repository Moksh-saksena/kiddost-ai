"use client";

import React, { useEffect, useRef, useState } from "react";
import { avatarDataUrl } from '../avatarDataUrl';
import { ArrowLeft, Send, MoreVertical, Check, CheckCheck, Info, X, FileText, ChevronLeft, CalendarPlus } from "lucide-react";
import { supabase } from '../../lib/supabase';

interface Message {
  id: string;
  text: string;
  sender: "me" | "other" | "system";
  time: string;
  read?: boolean;
  agent?: string | null;
  ai_enabled?: boolean;
  status?: string | null;
  media_url?: string | null;
}

interface ChatDetailProps {
  chatId: string;
  onBack: () => void;
  isDarkMode: boolean;
}

export function ChatDetail({ chatId, onBack, isDarkMode, messages: propMessages = [], chatName, chatAvatar, onSend, onSaveContact, initialContact, initialLabels = [], onAddLabel, onRemoveLabel, agentName }: ChatDetailProps & { messages?: Message[]; chatName?: string; chatAvatar?: string; onSend: (text: string) => Promise<void>; onSaveContact?: (name: string, notes: string) => void; initialContact?: { name: string; notes: string }; initialLabels?: string[]; onAddLabel?: (label: string) => void; onRemoveLabel?: (label: string) => void; agentName?: string }) {
  const [messages, setMessages] = useState<Message[]>(propMessages || []);
  const [inputValue, setInputValue] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [contactName, setContactName] = useState(initialContact?.name || '');
  const [contactNotes, setContactNotes] = useState(initialContact?.notes || '');
  const [labels, setLabels] = useState<string[]>(initialLabels);
  const [labelInput, setLabelInput] = useState('');
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<any>(null);
  const [templateVars, setTemplateVars] = useState<string[]>([]);
  const [templateSending, setTemplateSending] = useState(false);
  const [manualTemplateId, setManualTemplateId] = useState('');
  const [customerVars, setCustomerVars] = useState<{ children?: any[]; notes?: Record<string, string> } | null>(null);

  const SERVER = 'https://kiddost-ai.onrender.com';

  // Known templates — shown even when BotSpace listing API is unavailable
  const KNOWN_TEMPLATES = [
    { id: 'session', name: 'Session Today?', body: 'Hi, Would you like to go ahead with the session today?', language: 'en' },
  ];

  function getTemplateBody(t: any): string {
    const comps: any[] = t?.components || [];
    const body = comps.find(c => (c.type || '').toUpperCase() === 'BODY');
    return body?.text || t?.body || '';
  }

  function countVars(text: string): number {
    const m = text.match(/\{\{\d+\}\}/g) || [];
    if (!m.length) return 0;
    return Math.max(...m.map((s: string) => parseInt(s.replace(/\D/g, ''))));
  }

  const openTemplateModal = async () => {
    setShowTemplateModal(true);
    setSelectedTemplate(null);
    setTemplateVars([]);
    setTemplatesLoading(true);
    try {
      const res = await fetch(`${SERVER}/templates`);
      const json = await res.json();
      const fetched: any[] = json?.templates || json?.data || [];
      // Merge server results with known templates (deduplicate by id)
      const knownNotInFetched = KNOWN_TEMPLATES.filter(k => !fetched.find((f: any) => (f.id || f.name) === k.id));
      setTemplates([...fetched, ...knownNotInFetched]);
    } catch {
      setTemplates(KNOWN_TEMPLATES);
    } finally {
      setTemplatesLoading(false);
    }
  };

  const sendTemplate = async () => {
    const tid = selectedTemplate ? (selectedTemplate.id || selectedTemplate.name) : manualTemplateId.trim();
    if (!tid || templateSending) return;
    setTemplateSending(true);
    try {
      await fetch(`${SERVER}/send-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: chatId,
          templateId: tid,
          variables: templateVars.filter(v => v.trim() !== ''),
        })
      });
      setShowTemplateModal(false);
      setSelectedTemplate(null);
      setTemplateVars([]);
      setManualTemplateId('');
    } catch { /* silent */ }
    finally { setTemplateSending(false); }
  };

  // Reset info panel when switching chats
  useEffect(() => {
    setContactName(initialContact?.name || '');
    setContactNotes(initialContact?.notes || '');
    setShowInfo(false);
    setLabels(initialLabels || []);
    setLabelInput('');
    setCustomerVars(null);
  }, [chatId]);

  // Fetch conversation vars when info panel opens
  useEffect(() => {
    if (!showInfo) return;
    const cleanPhone = chatId.startsWith('+') ? chatId : `+${chatId}`;
    supabase.from('conversations').select('vars').eq('phone', cleanPhone).single()
      .then(({ data }) => {
        setCustomerVars(data?.vars || {});
      });
  }, [showInfo, chatId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);

  // Reset scroll tracking when switching chats
  useEffect(() => {
    prevLengthRef.current = 0;
  }, [chatId]);

  useEffect(() => {
    setMessages(propMessages || []);
  }, [propMessages]);

  // Smart scroll: instant on initial load, smooth on new message if already near bottom
  useEffect(() => {
    const end = messagesEndRef.current;
    const container = scrollContainerRef.current;
    if (!end || messages.length === 0) return;
    const isInitialLoad = prevLengthRef.current === 0;
    if (isInitialLoad) {
      end.scrollIntoView({ behavior: 'instant' });
    } else if (messages.length > prevLengthRef.current) {
      const isNearBottom = container
        ? container.scrollHeight - container.scrollTop - container.clientHeight < 200
        : true;
      if (isNearBottom) end.scrollIntoView({ behavior: 'smooth' });
    }
    prevLengthRef.current = messages.length;
  }, [messages]);

  const [sendCooldown, setSendCooldown] = useState(false);
  const handleSend = async () => {
    if (sendCooldown || !inputValue.trim()) return;
    const text = inputValue.trim();
    setInputValue("");
    setSendCooldown(true);
    await onSend(text);
    setTimeout(() => setSendCooldown(false), 1000);
  };

  const uploadMedia = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Direct upload to Supabase Storage (public bucket) to avoid server proxy limits
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9.\-_\.]/g, "_");
      const cleanPhone = String(chatId).replace(/^\+/, "");
      const path = `${cleanPhone}/${Date.now()}_${safeName}`;
      const { data: uploadData, error: uploadErr } = await supabase.storage.from('media').upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type || 'application/octet-stream' });
      if (uploadErr) {
        console.error('direct upload error', uploadErr.message || uploadErr);
        // fallback: try server upload
        try {
          const reader = new FileReader();
          reader.onload = async () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(',')[1];
            const resp = await fetch('https://kiddost-ai.onrender.com/upload-media-server', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileBase64: base64, fileName: file.name, fileType: file.type || 'application/octet-stream', phone: chatId })
            });
            const json = await resp.json();
            if (!json || !json.publicUrl) {
              console.error('server upload failed', json);
              return;
            }
            const publicURL = json.publicUrl;
            setMessages((prev) => [...prev, { id: `local-${Date.now()}`, text: '', sender: 'me', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), media_url: publicURL, status: 'sending' } as Message]);
            await fetch('https://kiddost-ai.onrender.com/agent-send-media', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone: chatId, mediaUrl: publicURL, caption: '' })
            });
          };
          reader.readAsDataURL(file);
        } catch (e) {
          console.error('fallback server upload failed', e);
        }
        return;
      }

      const publicRes = supabase.storage.from('media').getPublicUrl(path);
      const publicURL = publicRes?.data?.publicUrl || null;
      if (!publicURL) {
        console.error('failed to get public url for uploaded media');
        return;
      }

      setMessages((prev) => [...prev, { id: `local-${Date.now()}`, text: '', sender: 'me', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), media_url: publicURL, status: 'sending' } as Message]);

      await fetch('https://kiddost-ai.onrender.com/agent-send-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: chatId, mediaUrl: publicURL, caption: '' })
      });
    } catch (err) {
      console.error('uploadMedia error', err);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const name = chatName || "Unknown";
  const avatar = chatAvatar || avatarDataUrl(name);

  const handleSaveContact = () => {
    onSaveContact?.(contactName.trim(), contactNotes.trim());
    setShowInfo(false);
  };

  function resolveMediaUrl(url: string): string {
    if (!url) return url;
    // Route BotSpace-hosted media through the server proxy so browsers render inline
    if (url.includes('bot.space') || url.includes('botspace')) {
      return `https://kiddost-ai.onrender.com/proxy-image?url=${encodeURIComponent(url)}`;
    }
    return url;
  }

  function getMediaType(url: string): 'image' | 'video' | 'audio' | 'pdf' | 'file' {
    // Check for an explicit 'type' MIME hint in the query string (set by proxy URLs or server)
    try {
      const parsed = new URL(url);
      const typeParam = parsed.searchParams.get('type');
      if (typeParam) {
        if (typeParam.startsWith('image/')) return 'image';
        if (typeParam.startsWith('video/')) return 'video';
        if (typeParam.startsWith('audio/')) return 'audio';
        if (typeParam === 'application/pdf') return 'pdf';
      }
    } catch { /* ignore — not a valid absolute URL */ }
    const clean = url.split('?')[0].toLowerCase();
    if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|heic|heif)$/.test(clean)) return 'image';
    if (/\.(mp4|mov|avi|mkv|webm|3gp)$/.test(clean)) return 'video';
    if (/\.(mp3|ogg|wav|m4a|aac)$/.test(clean)) return 'audio';
    if (/\.pdf$/.test(clean)) return 'pdf';
    // Proxy URLs lack an extension — BotSpace primarily sends images, so default to image
    if (url.includes('/proxy-image')) return 'image';
    return 'file';
  }

  function MediaRenderer({ url, isDark }: { url: string; isDark: boolean }) {
    const resolved = resolveMediaUrl(url);
    const type = getMediaType(url);
    const linkClass = `text-sm underline ${isDark ? 'text-blue-300' : 'text-blue-600'}`;
    if (type === 'image') {
      return <img src={resolved} alt="media" className="w-48 rounded-md object-cover" />;
    }
    if (type === 'video') {
      return (
        <video controls className="w-48 rounded-md" preload="metadata">
          <source src={resolved} />
          <a href={resolved} target="_blank" rel="noreferrer" className={linkClass}>View video</a>
        </video>
      );
    }
    if (type === 'audio') {
      return (
        <audio controls className="w-48">
          <source src={resolved} />
          <a href={resolved} target="_blank" rel="noreferrer" className={linkClass}>Play audio</a>
        </audio>
      );
    }
    if (type === 'pdf') {
      return <a href={resolved} target="_blank" rel="noreferrer" className={linkClass}>📄 View PDF</a>;
    }
    return <a href={resolved} target="_blank" rel="noreferrer" className={linkClass}>📎 Download file</a>;
  }

  const [aiEnabledLocal, setAiEnabledLocal] = useState<boolean>(() => {
    const lm = messages && messages.length > 0 ? messages[messages.length - 1] : null;
    return lm && typeof lm.ai_enabled !== 'undefined' ? !!lm.ai_enabled : true;
  });
  const [handlerLocal, setHandlerLocal] = useState<string>(() => {
    const lm = messages && messages.length > 0 ? messages[messages.length - 1] : null;
    return lm && lm.agent ? lm.agent : (lm && lm.ai_enabled === false ? 'Agent' : 'AI 🤖');
  });

  // sync AI/handler state when messages change
  // Use the most recent message that has an explicit ai_enabled value — including system toggle messages
  React.useEffect(() => {
    if (messages.length === 0) return;
    const lastWithState = [...messages].reverse().find(m => typeof m.ai_enabled !== 'undefined');
    if (!lastWithState) return;
    const enabled = !!lastWithState.ai_enabled;
    setAiEnabledLocal(enabled);
    // Only update the agent name if this message actually carries one (agent messages / system messages).
    // Customer messages (sender=other) have no agent field — preserve whatever agent name we already have.
    if (lastWithState.sender !== 'other') {
      setHandlerLocal(lastWithState.agent ? lastWithState.agent : (enabled ? 'AI' : 'Agent'));
    }
  }, [messages]);

  const toggleAi = async (enable: boolean) => {
    try {
      const res = await fetch("https://kiddost-ai.onrender.com/toggle-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: chatId, ai_enabled: enable }),
      });
      if (res.ok) {
        setAiEnabledLocal(!!enable);
        setHandlerLocal(enable ? 'AI' : 'Agent');
      }
    } catch (err) {
      console.error("toggleAi error", err);
    }
  };

  // ── Calendar extraction state ──────────────────────────────────
  const [showCalModal, setShowCalModal] = useState(false);
  const [calExtracting, setCalExtracting] = useState(false);
  const [calTitle, setCalTitle] = useState('');
  const [calDate, setCalDate] = useState('');
  const [calStart, setCalStart] = useState('');
  const [calEnd, setCalEnd] = useState('');
  const [calNotes, setCalNotes] = useState('');
  const [calRepeat, setCalRepeat] = useState(1);
  const [calDays, setCalDays] = useState<number[]>([]);  // JS day numbers: 0=Sun,1=Mon,...6=Sat
  const [calTrial, setCalTrial] = useState(false);
  const [calMember, setCalMember] = useState('');
  const [calSaving, setCalSaving] = useState(false);
  const [calSuccess, setCalSuccess] = useState(false);

  const extractAndShowCalendar = async () => {
    setCalExtracting(true);
    setCalTitle(''); setCalDate(''); setCalStart(''); setCalEnd(''); setCalNotes(''); setCalRepeat(1); setCalDays([]); setCalTrial(false); setCalMember('');
    setCalSuccess(false);
    try {
      const res = await fetch(`${SERVER}/calendar/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: chatId }),
      });
      const json = await res.json();
      const ex = json.extracted;
      if (ex && (ex.title || ex.startTime || ex.start_time || ex.date || (Array.isArray(ex.repeatDays) && ex.repeatDays.length > 0))) {
        setCalTitle(ex.title || 'KidDost Session');
        // Compute date: use extracted date, or compute first occurrence from repeatDays
        if (ex.date) {
          setCalDate(ex.date);
        } else if (Array.isArray(ex.repeatDays) && ex.repeatDays.length > 0) {
          // Find the nearest upcoming occurrence of any repeat day
          const today = new Date();
          let best: Date | null = null;
          for (const targetDay of ex.repeatDays) {
            const diff = (targetDay - today.getDay() + 7) % 7 || 7;
            const candidate = new Date(today);
            candidate.setDate(today.getDate() + diff);
            if (!best || candidate < best) best = candidate;
          }
          setCalDate(best ? best.toISOString().split('T')[0] : new Date().toISOString().split('T')[0]);
        } else {
          setCalDate(new Date().toISOString().split('T')[0]);
        }
        setCalStart(ex.startTime || ex.start_time || '');
        setCalEnd(ex.endTime || ex.end_time || '');
        setCalNotes(ex.notes || '');
        setCalTrial(ex.isTrial === true);
        if (ex.repeatCount && ex.repeatCount > 1) setCalRepeat(ex.repeatCount);
        if (Array.isArray(ex.repeatDays) && ex.repeatDays.length > 0) setCalDays(ex.repeatDays);
      } else {
        setCalTitle('KidDost Session');
        setCalDate(new Date().toISOString().split('T')[0]);
      }
    } catch {
      setCalTitle('KidDost Session');
    } finally {
      setCalExtracting(false);
      setShowCalModal(true);
    }
  };

  const saveCalEvent = async () => {
    if (!calTitle.trim() || !calDate) return;
    setCalSaving(true);
    try {
      await fetch(`${SERVER}/calendar/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: chatId, title: calTitle.trim(), date: calDate, start_time: calStart || null, end_time: calEnd || null, notes: calNotes.trim() || null, created_by: agentName || null, assigned_member: calMember.trim() || null, repeat_count: calRepeat > 1 ? calRepeat : undefined, repeat_days: calDays.length > 0 ? calDays : undefined, is_trial: calTrial }),
      });
      setCalSuccess(true);
      setTimeout(() => { setShowCalModal(false); setCalSuccess(false); }, 1200);
    } catch { /* silent */ }
    finally { setCalSaving(false); }
  };

  const calInputCls = `w-full rounded-xl px-4 py-3 text-sm outline-none transition-all ${isDarkMode ? 'bg-gray-800 border border-blue-500/30 text-white placeholder:text-gray-600 focus:border-blue-500' : 'bg-gray-100 border border-gray-200 text-gray-900 focus:border-[#008069]'}`;

  return (
    <div className={`flex flex-col h-full relative overflow-hidden ${isDarkMode ? "bg-black" : "bg-[#efeae2]"}`}>
      {isDarkMode && (
        <div className="absolute inset-0 opacity-30">
          <div className="absolute w-1 h-1 bg-blue-400 rounded-full top-[10%] left-[20%]" style={{ boxShadow: "0 0 3px rgba(96, 165, 250, 0.8)" }} />
          <div className="absolute w-1 h-1 bg-cyan-400 rounded-full top-[30%] left-[80%]" style={{ boxShadow: "0 0 3px rgba(34, 211, 238, 0.8)" }} />
          <div className="absolute w-1 h-1 bg-blue-300 rounded-full top-[60%] left-[15%]" style={{ boxShadow: "0 0 3px rgba(147, 197, 253, 0.8)" }} />
          <div className="absolute w-1 h-1 bg-cyan-300 rounded-full top-[80%] left-[70%]" style={{ boxShadow: "0 0 3px rgba(103, 232, 249, 0.8)" }} />
        </div>
      )}

      <div className={`text-white px-4 py-3 flex items-center relative z-10 ${isDarkMode ? "bg-gradient-to-r from-gray-900 via-gray-800 to-gray-900" : "bg-[#008069]"}`}>
        {isDarkMode && <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />}
        <button onClick={onBack} className={`mr-3 relative z-10 ${isDarkMode ? "hover:scale-110" : ""} transition-transform`}>
          <ArrowLeft className="w-6 h-6" />
        </button>
        <div className="relative">
          <img src={avatar} alt={name} className="w-11 h-11 rounded-full object-cover" />
        </div>
        <div className="flex-1 ml-3 relative z-10">
          <h2 className="font-medium">{name}</h2>
          <p className={`text-xs ${isDarkMode ? "text-white" : "text-gray-200"}`}>Online</p>
          <div className="text-xs mt-1 flex items-center gap-2">
            <span className={`text-sm ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}><strong>Handled by:</strong> {handlerLocal}</span>
            {aiEnabledLocal ? (
              <button onClick={() => toggleAi(false)} className="ml-2 px-2 py-1 text-xs rounded bg-red-600 text-white">Stop AI</button>
            ) : (
              <button onClick={() => toggleAi(true)} className="ml-2 px-2 py-1 text-xs rounded bg-green-600 text-white">Resume AI</button>
            )}
          </div>
        </div>
        <button className={`relative z-10 mr-2 ${isDarkMode ? "hover:scale-110" : ""} transition-transform`} onClick={extractAndShowCalendar} disabled={calExtracting} title="Add to Calendar">
          <CalendarPlus className={`w-5 h-5 ${calExtracting ? 'animate-pulse' : ''}`} />
        </button>
        <button className={`relative z-10 ${isDarkMode ? "hover:scale-110" : ""} transition-transform`} onClick={() => setShowInfo(true)}>
          <Info className="w-6 h-6" />
        </button>
      </div>

      {/* Info / Notes drawer */}
      {showInfo && (
        <div className={`absolute inset-0 z-50 flex flex-col ${ isDarkMode ? 'bg-gray-950' : 'bg-white'}`}>
          <div className={`flex items-center gap-3 px-4 py-4 border-b ${ isDarkMode ? 'border-blue-900/30 text-white' : 'border-gray-200 text-gray-900'}`}>
            <button onClick={() => setShowInfo(false)} className="hover:opacity-70 transition-opacity">
              <X className="w-5 h-5" />
            </button>
            <h2 className="font-semibold text-base flex-1">Contact Info</h2>
            <button onClick={handleSaveContact} className={`text-sm font-semibold px-3 py-1 rounded-lg ${ isDarkMode ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-[#008069] text-white'} transition-colors`}>Save</button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-6 flex flex-col gap-6">
            {/* Phone */}
            <div>
              <label className={`text-xs font-medium mb-1 block ${ isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>PHONE</label>
              <p className={`text-sm ${ isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>{chatId}</p>
            </div>
            {/* Display name */}
            <div>
              <label className={`text-xs font-medium mb-1.5 block ${ isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>DISPLAY NAME</label>
              <input
                type="text"
                value={contactName}
                onChange={e => setContactName(e.target.value)}
                placeholder="e.g. Rahul Sharma"
                className={`w-full rounded-xl px-4 py-3 text-base outline-none transition-all ${ isDarkMode ? 'bg-gray-900 border border-blue-500/30 text-white placeholder:text-gray-600 focus:border-blue-500' : 'bg-gray-100 border border-gray-200 text-gray-900 focus:border-[#008069]'}`}
              />
            </div>
            {/* Notes */}
            <div>
              <label className={`text-xs font-medium mb-1.5 block ${ isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>NOTES</label>
              <textarea
                value={contactNotes}
                onChange={e => setContactNotes(e.target.value)}
                placeholder="Add any notes about this customer..."
                rows={4}
                className={`w-full rounded-xl px-4 py-3 text-base outline-none resize-none transition-all ${ isDarkMode ? 'bg-gray-900 border border-blue-500/30 text-white placeholder:text-gray-600 focus:border-blue-500' : 'bg-gray-100 border border-gray-200 text-gray-900 focus:border-[#008069]'}`}
              />
            </div>
            {/* Labels */}
            <div>
              <label className={`text-xs font-medium mb-1.5 block ${ isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>LABELS</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {labels.map(l => (
                  <span key={l} className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${ isDarkMode ? 'bg-blue-900/60 text-blue-200' : 'bg-green-100 text-green-800'}`}>
                    {l}
                  <button onClick={() => { onRemoveLabel?.(l); setLabels(prev => prev.filter(x => x !== l)); }} className="ml-1 hover:opacity-70">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={labelInput}
                  onChange={e => setLabelInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && labelInput.trim()) {
                      const l = labelInput.trim();
                      onAddLabel?.(l);
                      setLabels(prev => prev.includes(l) ? prev : [...prev, l]);
                      setLabelInput('');
                    }
                  }}
                  placeholder="Type label + Enter"
                  className={`flex-1 rounded-xl px-3 py-2 text-base outline-none ${ isDarkMode ? 'bg-gray-900 border border-blue-500/30 text-white placeholder:text-gray-600' : 'bg-gray-100 border border-gray-200 text-gray-900'}`}
                />
                <button
                  onClick={() => {
                    if (labelInput.trim()) {
                      const l = labelInput.trim();
                      onAddLabel?.(l);
                      setLabels(prev => prev.includes(l) ? prev : [...prev, l]);
                      setLabelInput('');
                    }
                  }}
                  className={`px-3 py-2 rounded-xl text-sm font-medium ${ isDarkMode ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-[#008069] text-white'}`}
                >Add</button>
              </div>
            </div>
            {/* AI-extracted customer facts */}
            {customerVars && (
              <div>
                <label className={`text-xs font-medium mb-1.5 block ${ isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>AI-EXTRACTED FACTS</label>
                {(!customerVars.children?.length && !Object.keys(customerVars.notes || {}).length) ? (
                  <p className={`text-xs italic ${ isDarkMode ? 'text-gray-600' : 'text-gray-400'}`}>No facts extracted yet</p>
                ) : (
                  <div className={`rounded-xl px-4 py-3 text-sm space-y-2 ${ isDarkMode ? 'bg-gray-900 border border-blue-500/30' : 'bg-gray-50 border border-gray-200'}`}>
                    {customerVars.children && customerVars.children.length > 0 && (
                      <div>
                        <span className={`text-xs font-medium ${ isDarkMode ? 'text-blue-300' : 'text-green-700'}`}>Children</span>
                        <div className="flex flex-wrap gap-1.5 mt-1">
                          {customerVars.children.map((c: any, i: number) => (
                            <span key={i} className={`px-2 py-0.5 rounded-full text-xs ${ isDarkMode ? 'bg-blue-900/60 text-blue-200' : 'bg-green-100 text-green-800'}`}>
                              {c.name || 'Unnamed'}{c.age ? ` (${c.age})` : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {customerVars.notes && Object.keys(customerVars.notes).length > 0 && (
                      <div className="space-y-1">
                        {Object.entries(customerVars.notes).map(([key, val]) => (
                          <div key={key} className="flex gap-2 text-xs">
                            <span className={`font-medium whitespace-nowrap ${ isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}:</span>
                            <span className={isDarkMode ? 'text-gray-200' : 'text-gray-800'}>{String(val)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-4 relative z-10">
        {messages.filter(m => m.sender !== 'system').map((message) => {
          const isMe = message.sender === 'me';
          return (
            <div key={message.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${isDarkMode ? (isMe ? 'bg-gradient-to-r from-blue-800 to-blue-700 text-white backdrop-blur-sm' : 'bg-gray-900/80 text-gray-100 border border-blue-500/20 backdrop-blur-sm') : (isMe ? 'bg-[#d9fdd3]' : 'bg-white')}`} style={isDarkMode ? (isMe ? { boxShadow: '0 0 15px rgba(37, 99, 235, 0.2)' } : { boxShadow: '0 0 15px rgba(59, 130, 246, 0.1)' }) : {}}>
                {message.media_url && (
                  <div className="mb-2">
                    <MediaRenderer url={message.media_url} isDark={isDarkMode} />
                  </div>
                )}
                {message.text ? <p className={`text-sm ${isDarkMode ? '' : 'text-gray-900'}`}>{message.text}</p> : null}
                <div className={`flex items-center justify-end gap-1 mt-1.5 text-xs ${isDarkMode ? (isMe ? 'text-blue-200' : 'text-blue-400') : 'text-gray-500'}`}>
                  <span>{message.time}</span>
                  {isMe && (() => {
                    const s = message.status?.toLowerCase() || '';
                    if (s === 'read' || s === 'seen') return <CheckCheck className="w-4 h-4" style={{ color: '#22aaff' }} />;
                    if (s === 'delivered' || s === 'delivery') return <CheckCheck className="w-4 h-4" style={{ color: isDarkMode ? '#9ca3af' : '#6b7280' }} />;
                    if (s === 'sent' || s === 'accepted' || s === 'enqueued') return <Check className="w-4 h-4" style={{ color: isDarkMode ? '#9ca3af' : '#6b7280' }} />;
                    return <Check className="w-4 h-4" style={{ color: isDarkMode ? '#4b5563' : '#d1d5db' }} />;
                  })()}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Template picker modal */}
      {showTemplateModal && (
        <div className={`absolute inset-0 z-50 flex flex-col ${isDarkMode ? 'bg-gray-950' : 'bg-white'}`}>
          {/* Header */}
          <div className={`flex items-center gap-3 px-4 py-4 border-b ${isDarkMode ? 'border-blue-900/30 text-white' : 'border-gray-200 text-gray-900'}`}>
            {selectedTemplate ? (
              <button onClick={() => { setSelectedTemplate(null); setTemplateVars([]); }} className="hover:opacity-70">
                <ChevronLeft className="w-5 h-5" />
              </button>
            ) : (
              <button onClick={() => setShowTemplateModal(false)} className="hover:opacity-70">
                <X className="w-5 h-5" />
              </button>
            )}
            <h2 className="font-semibold text-base flex-1">
              {selectedTemplate ? selectedTemplate.name : 'Send Template'}
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
            {/* Step 1: template list */}
            {!selectedTemplate && (
              templatesLoading ? (
                <p className={`text-center text-sm py-10 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Loading templates…</p>
              ) : templates.length === 0 ? (
                // Fallback: manual template ID entry when listing API is unavailable
                <div className="flex flex-col gap-4 pt-2">
                  <p className={`text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                    Could not load template list. Enter the template ID manually (find it in your BotSpace dashboard).
                  </p>
                  <div>
                    <label className={`text-xs font-semibold mb-1.5 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>TEMPLATE ID</label>
                    <input
                      type="text"
                      value={manualTemplateId}
                      onChange={e => setManualTemplateId(e.target.value)}
                      placeholder="e.g. payment_reminder"
                      className={`w-full rounded-xl px-4 py-3 text-sm outline-none ${
                        isDarkMode ? 'bg-gray-900 border border-blue-500/30 text-white placeholder:text-gray-600 focus:border-blue-500' : 'bg-gray-100 border border-gray-200 text-gray-900 focus:border-[#008069]'
                      }`}
                    />
                  </div>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <p className={`text-xs font-semibold ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>VARIABLES (if any)</p>
                      <button
                        onClick={() => setTemplateVars(prev => [...prev, ''])}
                        className={`text-xs px-2 py-1 rounded-lg ${isDarkMode ? 'bg-gray-800 text-blue-400 hover:bg-gray-700' : 'bg-gray-100 text-[#008069] hover:bg-gray-200'}`}
                      >+ Add</button>
                    </div>
                    {templateVars.map((v, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <span className={`text-xs w-6 text-center flex-shrink-0 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>{i + 1}</span>
                        <input
                          type="text"
                          value={v}
                          onChange={e => setTemplateVars(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                          placeholder={`Variable ${i + 1}`}
                          className={`flex-1 rounded-xl px-3 py-2 text-sm outline-none ${
                            isDarkMode ? 'bg-gray-900 border border-blue-500/30 text-white placeholder:text-gray-600 focus:border-blue-500' : 'bg-gray-100 border border-gray-200 text-gray-900 focus:border-[#008069]'
                          }`}
                        />
                        <button onClick={() => setTemplateVars(prev => prev.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-300">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={sendTemplate}
                    disabled={templateSending || !manualTemplateId.trim()}
                    className={`w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-40 active:scale-95 transition-all ${
                      isDarkMode ? 'bg-gradient-to-r from-blue-700 to-blue-600 text-white hover:from-blue-600 hover:to-blue-500' : 'bg-[#008069] text-white hover:bg-[#017a5f]'
                    }`}
                  >
                    {templateSending ? 'Sending…' : 'Send Template'}
                  </button>
                </div>
              ) : templates.map((t: any) => {
                const body = getTemplateBody(t);
                return (
                  <button
                    key={t.id || t.name}
                    onClick={() => { setSelectedTemplate(t); setTemplateVars([]); }}
                    className={`w-full text-left rounded-xl px-4 py-3 transition-all ${
                      isDarkMode ? 'bg-gray-900 border border-blue-900/30 hover:border-blue-500/50 text-white' : 'bg-gray-50 border border-gray-200 hover:border-[#008069] text-gray-900'
                    }`}
                  >
                    <p className="font-medium text-sm mb-1">{t.name}</p>
                    {body && <p className={`text-xs line-clamp-2 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{body}</p>}
                    {t.language && <p className={`text-[10px] mt-1 ${isDarkMode ? 'text-blue-500' : 'text-[#008069]'}`}>{t.language}</p>}
                  </button>
                );
              })
            )}

            {/* Step 2: fill variables */}
            {selectedTemplate && (() => {
              const bodyText = getTemplateBody(selectedTemplate);
              const varCount = countVars(bodyText);
              return (
                <div className="flex flex-col gap-4">
                  {bodyText && (
                    <div className={`rounded-xl px-4 py-3 text-sm ${isDarkMode ? 'bg-gray-900 text-gray-300 border border-blue-900/30' : 'bg-gray-50 text-gray-700 border border-gray-200'}`}>
                      <p className={`text-[10px] font-semibold mb-1 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>PREVIEW</p>
                      {bodyText}
                    </div>
                  )}
                  {/* Variables — shown if body has {{n}} or user can add manually */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <p className={`text-xs font-semibold ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>VARIABLES</p>
                      <button
                        onClick={() => setTemplateVars(prev => [...prev, ''])}
                        className={`text-xs px-2 py-1 rounded-lg ${isDarkMode ? 'bg-gray-800 text-blue-400 hover:bg-gray-700' : 'bg-gray-100 text-[#008069] hover:bg-gray-200'}`}
                      >+ Add</button>
                    </div>
                    {templateVars.length === 0 && (
                      <p className={`text-xs ${isDarkMode ? 'text-gray-600' : 'text-gray-400'}`}>No variables — tap + Add if your template needs them.</p>
                    )}
                    {templateVars.map((v, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <span className={`text-xs w-6 text-center flex-shrink-0 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>{i + 1}</span>
                        <input
                          type="text"
                          value={v}
                          onChange={e => setTemplateVars(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                          placeholder={`Variable ${i + 1}`}
                          className={`flex-1 rounded-xl px-3 py-2 text-sm outline-none ${
                            isDarkMode ? 'bg-gray-900 border border-blue-500/30 text-white placeholder:text-gray-600 focus:border-blue-500' : 'bg-gray-100 border border-gray-200 text-gray-900 focus:border-[#008069]'
                          }`}
                        />
                        <button onClick={() => setTemplateVars(prev => prev.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-300">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={sendTemplate}
                    disabled={templateSending}
                    className={`w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-40 active:scale-95 transition-all ${
                      isDarkMode ? 'bg-gradient-to-r from-blue-700 to-blue-600 text-white hover:from-blue-600 hover:to-blue-500' : 'bg-[#008069] text-white hover:bg-[#017a5f]'
                    }`}
                  >
                    {templateSending ? 'Sending…' : 'Send Template'}
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      <div className={`px-4 py-3 flex items-end gap-3 relative z-10 ${isDarkMode ? "bg-gradient-to-t from-gray-900 to-black border-t border-blue-900/30" : "bg-[#f0f0f0]"}`}>
        <label className="cursor-pointer mb-1.5">
          <input type="file" onChange={uploadMedia} className="hidden" />
          <div className={`px-3 py-2 rounded-full ${isDarkMode ? 'bg-gray-800 text-white' : 'bg-white text-gray-700'}`}>+</div>
        </label>
        <button
          onClick={openTemplateModal}
          title="Send Template"
          className={`p-2 mb-1 rounded-full transition-all flex-shrink-0 ${isDarkMode ? 'bg-gray-800 text-blue-400 hover:bg-gray-700' : 'bg-white text-[#008069] hover:bg-gray-100'}`}
        >
          <FileText className="w-5 h-5" />
        </button>
        <textarea rows={3} value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyPress={handleKeyPress} placeholder={isDarkMode ? "Transmit message..." : "Type a message"} className={`flex-1 rounded-2xl px-4 py-2.5 outline-none text-base resize-none ${isDarkMode ? "bg-gray-900/70 border border-blue-500/30 text-gray-100 placeholder:text-gray-600 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 backdrop-blur-sm" : "bg-white border border-gray-300 text-gray-900 focus:border-[#008069] focus:ring-2 focus:ring-[#008069]/20"} transition-all`} />
        <button onClick={handleSend} disabled={sendCooldown} className={`p-3 mb-1 rounded-full active:scale-95 transition-all ${sendCooldown ? 'opacity-40 cursor-not-allowed' : ''} ${isDarkMode ? "bg-gradient-to-r from-blue-800 to-blue-700 text-white hover:from-blue-700 hover:to-blue-600" : "bg-[#008069] text-white hover:bg-[#017a5f]"}`} style={isDarkMode ? { boxShadow: "0 0 15px rgba(37, 99, 235, 0.3)" } : {}}>
          <Send className="w-5 h-5" />
        </button>
      </div>

      {/* Calendar extraction confirmation modal */}
      {showCalModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowCalModal(false)}>
          <div
            className={`w-full max-w-md rounded-t-2xl p-6 pb-10 shadow-2xl flex flex-col gap-4 ${isDarkMode ? 'bg-gray-900 border-t border-blue-900/40' : 'bg-white border-t border-gray-200'}`}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className={`font-semibold text-base ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
                {calSuccess ? '✓ Event Created!' : 'Add to Calendar'}
              </h2>
              <button onClick={() => setShowCalModal(false)} className="hover:opacity-70">
                <X className={`w-5 h-5 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} />
              </button>
            </div>
            {calSuccess ? (
              <p className={`text-sm ${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>Session saved to calendar.</p>
            ) : (
              <>
                <p className={`text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                  AI extracted these details from the last 8 messages. Edit anything before saving.
                </p>
                <div>
                  <label className={`text-xs font-medium mb-1 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>TITLE</label>
                  <input type="text" value={calTitle} onChange={e => setCalTitle(e.target.value)} placeholder="Session title" className={calInputCls} />
                </div>
                <div>
                  <label className={`text-xs font-medium mb-1 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>DATE</label>
                  <input type="date" value={calDate} onChange={e => setCalDate(e.target.value)} className={calInputCls} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={`text-xs font-medium mb-1 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>START</label>
                    <input type="time" value={calStart} onChange={e => setCalStart(e.target.value)} className={calInputCls} />
                  </div>
                  <div>
                    <label className={`text-xs font-medium mb-1 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>END</label>
                    <input type="time" value={calEnd} onChange={e => setCalEnd(e.target.value)} className={calInputCls} />
                  </div>
                </div>
                <div>
                  <label className={`text-xs font-medium mb-1 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>ASSIGNED MEMBER</label>
                  <input type="text" value={calMember} onChange={e => setCalMember(e.target.value)} placeholder="e.g. Priya, Rahul..." className={calInputCls} />
                </div>
                <div>
                  <label className={`text-xs font-medium mb-1 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>NOTES</label>
                  <textarea value={calNotes} onChange={e => setCalNotes(e.target.value)} placeholder="Location, special instructions..." rows={2} className={`${calInputCls} resize-none`} />
                </div>
                <button
                  type="button"
                  onClick={() => setCalTrial(!calTrial)}
                  className={`flex items-center gap-3 w-full rounded-xl px-4 py-3 text-sm font-medium transition-all border ${
                    calTrial
                      ? 'bg-orange-50 border-orange-400 text-orange-600'
                      : isDarkMode ? 'bg-gray-800 border-blue-500/30 text-gray-400' : 'bg-gray-100 border-gray-200 text-gray-500'
                  }`}
                >
                  <div className={`w-5 h-5 rounded-md flex items-center justify-center text-xs font-bold ${calTrial ? 'bg-orange-400 text-white' : isDarkMode ? 'bg-gray-700' : 'bg-gray-300'}`}>
                    {calTrial ? '✓' : ''}
                  </div>
                  Trial Session
                  {calTrial && <span className="ml-auto text-xs font-bold bg-orange-400 text-white px-2 py-0.5 rounded">TRIAL</span>}
                </button>
                <div>
                  <label className={`text-xs font-medium mb-1 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>TOTAL SESSIONS</label>
                  <div className="flex items-center gap-3">
                    <input type="range" min={1} max={30} value={calRepeat} onChange={e => setCalRepeat(parseInt(e.target.value))} className="flex-1 accent-blue-500" />
                    <span className={`text-sm font-semibold min-w-[3rem] text-center ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>{calRepeat === 1 ? 'Once' : `${calRepeat}x`}</span>
                  </div>
                  {calRepeat > 1 && <p className={`text-xs mt-1 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>Creates {calRepeat} sessions{calDays.length > 1 ? ` across ${calDays.length} days/week (~${Math.ceil(calRepeat / calDays.length)} weeks)` : ` (${calRepeat} weeks)`} starting {calDate || 'selected date'}</p>}
                  <div className="flex gap-2 mt-2">
                    {[1, 4, 8, 11].map(n => (
                      <button key={n} type="button" onClick={() => setCalRepeat(n)} className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${calRepeat === n ? (isDarkMode ? 'bg-blue-600 text-white' : 'bg-[#008069] text-white') : (isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-200 text-gray-600')}`}>{n === 1 ? 'Once' : `${n}x`}</button>
                    ))}
                  </div>
                  {calRepeat > 1 && (
                    <div className="mt-3">
                      <label className={`text-xs font-medium mb-1 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>DAYS OF WEEK</label>
                      <div className="flex gap-1.5">
                        {(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as const).map((day, idx) => (
                          <button key={day} type="button" onClick={() => setCalDays(prev => prev.includes(idx) ? prev.filter(d => d !== idx) : [...prev, idx].sort())}
                            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${calDays.includes(idx) ? (isDarkMode ? 'bg-blue-600 text-white' : 'bg-[#008069] text-white') : (isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-200 text-gray-600')}`}
                          >{day}</button>
                        ))}
                      </div>
                      {calDays.length === 0 && <p className={`text-xs mt-1 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>No days selected — will repeat on same weekday as start date</p>}
                    </div>
                  )}
                </div>
                <button
                  onClick={saveCalEvent}
                  disabled={calSaving || !calTitle.trim() || !calDate}
                  className={`w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 active:scale-95 ${isDarkMode ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-[#008069] text-white hover:bg-[#006d5b]'}`}
                >
                  {calSaving ? 'Saving...' : calRepeat > 1 ? `Save ${calRepeat} Sessions` : 'Save to Calendar'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
