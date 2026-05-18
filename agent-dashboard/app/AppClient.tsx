"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChatList } from "./components/ChatList";
import { ChatDetail } from "./components/ChatDetail";
import { Calendar } from "./components/Calendar";
import "./mobile-styles.css";
import { avatarDataUrl } from './avatarDataUrl';
import { supabase } from "../lib/supabase";

const SERVER = "https://kiddost-ai.onrender.com";
const SESSION_KEY = "kiddost_auth";

type Chat = { id: string; name: string; avatar: string; lastMessage: string; time: string; unread?: number; agent?: string | null; lastMsgAt?: string; labels?: string[]; pinned?: boolean; needsHuman?: boolean };
type Message = { id: string; text: string; sender: "me" | "other" | "system"; time: string; agent?: string | null; ai_enabled?: boolean; status?: string | null; media_url?: string | null; whatsapp_id?: string | null };
type AgentProfile = { id: string; name: string };

function avatarColor(name: string) {
  const palette = ['from-blue-600 to-blue-400', 'from-purple-600 to-purple-400', 'from-emerald-600 to-emerald-400', 'from-orange-500 to-amber-400', 'from-pink-600 to-pink-400', 'from-cyan-600 to-cyan-400'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % palette.length;
  return palette[h];
}

function avatarInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function LoginScreen({ onLogin }: { onLogin: (name: string) => void }) {
  const [mode, setMode] = useState<'pick' | 'pin' | 'create_step1' | 'create_step2'>('pick');
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<AgentProfile | null>(null);
  const [pin, setPin] = useState("");
  const [newName, setNewName] = useState("");
  const [newPin, setNewPin] = useState("");
  const [otp, setOtp] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${SERVER}/agents`)
      .then(r => r.json())
      .then(j => setAgents(j.agents || []))
      .catch(() => setAgents([]))
      .finally(() => setLoadingAgents(false));
  }, []);

  const handleSelectAgent = (agent: AgentProfile) => {
    setSelectedAgent(agent); setPin(""); setError(""); setMode('pin');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim() || !selectedAgent) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(`${SERVER}/agent-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: pin.trim(), agentId: selectedAgent.id }),
      });
      const json = await res.json();
      if (res.ok && json.name) {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ name: json.name, id: selectedAgent.id }));
        setPin("");
        onLogin(json.name);
      } else if (!res.ok) {
        setError(json.error === 'invalid_pin' ? "Incorrect PIN." : "Login failed. Try again.");
      }
    } catch { setError("Connection error. Try again."); }
    finally { setLoading(false); }
  };

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPin.trim()) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(`${SERVER}/request-agent-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (res.ok && json.token) {
        setToken(json.token);
        setMode('create_step2');
      } else {
        setError(json.error === 'no_admin_phone_configured'
          ? "Admin phone not configured on server."
          : "Failed to send OTP. Try again.");
      }
    } catch { setError("Connection error. Try again."); }
    finally { setLoading(false); }
  };

  const subtitle = mode === 'pick' ? 'Who are you?' : mode === 'pin' ? `Welcome, ${selectedAgent?.name}` : 'New Agent';

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp.trim()) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(`${SERVER}/create-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, otp: otp.trim(), name: newName.trim(), pin: newPin.trim() }),
      });
      const json = await res.json();
      if (res.ok) {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ name: json.name, id: json.id ?? null }));
        onLogin(json.name);
      } else {
        const msg = json.error === 'invalid_otp' ? "Incorrect OTP."
          : json.error === 'otp_expired' ? "OTP expired. Request a new one."
          : "Failed to create agent.";
        setError(msg);
        if (json.error === 'otp_expired') { setMode('create_step1'); setOtp(""); }
      }
    } catch { setError("Connection error. Try again."); }
    finally { setLoading(false); }
  };

  const inputCls = "w-full rounded-xl px-5 py-3 bg-gray-900 border border-blue-500/30 text-white outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all";
  const btnCls = "w-full py-4 rounded-xl bg-gradient-to-r from-blue-700 to-blue-600 text-white font-semibold text-sm disabled:opacity-40 hover:from-blue-600 hover:to-blue-500 active:scale-95 transition-all";

  return (
    <div className="h-screen max-w-md mx-auto flex flex-col items-center justify-center bg-black" style={{ boxShadow: "0 0 100px rgba(59,130,246,0.3)" }}>
      <div className="mb-8 text-center">
        <div className="text-4xl mb-2">🐣</div>
        <h1 className="text-2xl font-bold text-white tracking-wide">Kiddost</h1>
        <p className="text-gray-500 text-sm mt-1">{subtitle}</p>
      </div>

      {mode === 'pick' && (
        <div className="w-full px-8 flex flex-col items-center gap-8">
          {loadingAgents ? (
            <p className="text-gray-600 text-sm animate-pulse">Loading profiles...</p>
          ) : agents.length === 0 ? (
            <p className="text-gray-600 text-sm">No agents yet. Create the first one below.</p>
          ) : (
            <div className="flex flex-wrap justify-center gap-8">
              {agents.map(agent => (
                <button key={agent.id} onClick={() => handleSelectAgent(agent)} className="flex flex-col items-center gap-3 group">
                  <div className={`w-20 h-20 rounded-2xl bg-gradient-to-br ${avatarColor(agent.name)} flex items-center justify-center text-white text-2xl font-bold group-hover:scale-110 group-active:scale-95 transition-transform duration-200`} style={{ boxShadow: '0 0 25px rgba(59,130,246,0.3)' }}>
                    {avatarInitials(agent.name)}
                  </div>
                  <span className="text-gray-400 text-sm font-medium group-hover:text-white transition-colors">{agent.name}</span>
                </button>
              ))}
            </div>
          )}
          <button onClick={() => { setMode('create_step1'); setError(""); }} className="flex items-center gap-2 text-gray-600 text-xs hover:text-gray-400 transition-colors mt-2">
            <span className="w-6 h-6 rounded-full border border-gray-700 flex items-center justify-center hover:border-gray-500 transition-colors text-base leading-none">+</span>
            Request access for new agent
          </button>
        </div>
      )}

      {mode === 'pin' && selectedAgent && (
        <form onSubmit={handleLogin} className="w-full px-10 flex flex-col gap-4">
          <div className="flex flex-col items-center mb-2">
            <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${avatarColor(selectedAgent.name)} flex items-center justify-center text-white text-xl font-bold mb-2`} style={{ boxShadow: '0 0 20px rgba(59,130,246,0.3)' }}>
              {avatarInitials(selectedAgent.name)}
            </div>
          </div>
          <div>
            <label className="text-gray-400 text-xs mb-1 block text-center">ENTER YOUR PIN</label>
            <input type="password" value={pin} onChange={(e) => setPin(e.target.value)}
              placeholder="••••••" maxLength={20} autoFocus
              className={`${inputCls} text-center text-2xl tracking-widest`} />
          </div>
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <button type="submit" disabled={loading || !pin.trim()} className={btnCls}
            style={{ boxShadow: "0 0 20px rgba(37,99,235,0.4)" }}>
            {loading ? "Verifying..." : "Sign In"}
          </button>
          <button type="button" onClick={() => { setMode('pick'); setError(""); setPin(""); }}
            className="text-gray-600 text-xs text-center hover:text-gray-400 transition-colors">
            Switch profile
          </button>
        </form>
      )}

      {mode === 'create_step1' && (
        <form onSubmit={handleRequestOtp} className="w-full px-10 flex flex-col gap-4">
          <p className="text-gray-500 text-xs text-center">An OTP will be sent to the admin’s WhatsApp to verify this request.</p>
          <div>
            <label className="text-gray-400 text-xs mb-1 block">AGENT NAME</label>
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Priya" maxLength={30} autoFocus className={inputCls} />
          </div>
          <div>
            <label className="text-gray-400 text-xs mb-1 block">CHOOSE A PIN</label>
            <input type="password" value={newPin} onChange={(e) => setNewPin(e.target.value)}
              placeholder="Pick a secret PIN" maxLength={20} className={inputCls} />
          </div>
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <button type="submit" disabled={loading || !newName.trim() || !newPin.trim()} className={btnCls}
            style={{ boxShadow: "0 0 20px rgba(37,99,235,0.4)" }}>
            {loading ? "Sending OTP..." : "Send OTP to Admin"}
          </button>
          <button type="button" onClick={() => { setMode('pick'); setError(""); }}
            className="text-gray-600 text-xs text-center hover:text-gray-400 transition-colors">
            Back
          </button>
        </form>
      )}

      {mode === 'create_step2' && (
        <form onSubmit={handleCreateAgent} className="w-full px-10 flex flex-col gap-4">
          <p className="text-gray-500 text-xs text-center">Enter the 6-digit OTP sent to the admin’s WhatsApp.</p>
          <div>
            <label className="text-gray-400 text-xs mb-1 block">OTP</label>
            <input type="text" inputMode="numeric" value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              placeholder="123456" maxLength={6} autoFocus
              className={`${inputCls} text-center text-2xl tracking-widest`} />
          </div>
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <button type="submit" disabled={loading || otp.length < 6} className={btnCls}
            style={{ boxShadow: "0 0 20px rgba(37,99,235,0.4)" }}>
            {loading ? "Creating agent..." : "Create Agent"}
          </button>
          <button type="button" onClick={() => { setMode('create_step1'); setError(""); setOtp(""); }}
            className="text-gray-600 text-xs text-center hover:text-gray-400 transition-colors">
            ← Back
          </button>
        </form>
      )}
    </div>
  );
}

const CONTACTS_KEY = 'kiddost_contacts';
const PINNED_CHATS_KEY = 'kiddost_pinned_chats';
function getContacts(): Record<string, { name: string; notes: string; labels?: string[] }> {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(CONTACTS_KEY) || '{}'); } catch { return {}; }
}
function saveContact(phone: string, data: { name: string; notes: string; labels?: string[] }) {
  const all = getContacts();
  all[phone] = data;
  try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(all)); } catch {}
}

function getPinnedStore(): Record<string, string[]> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_CHATS_KEY) || '{}');
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return {};
}

function setPinnedStore(store: Record<string, string[]>) {
  try { localStorage.setItem(PINNED_CHATS_KEY, JSON.stringify(store)); } catch {}
}

export default function AppClient() {
  const [authed, setAuthed] = useState<boolean>(false);
  const [agentName, setAgentName] = useState<string>('Agent');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePin, setDeletePin] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [contacts, setContacts] = useState<Record<string, { name: string; notes: string; labels?: string[] }>>({});

  // Read all localStorage state after mount to avoid SSR hydration mismatch
  useEffect(() => {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
      if (session.name) {
        setAuthed(true);
        setAgentName(session.name);
        setAgentId(session.id ?? null);
      }
    } catch {}
    setContacts(getContacts());
  }, []);

  // Load shared contacts from server on mount
  useEffect(() => {
    fetch(`${SERVER}/contacts`)
      .then(r => r.json())
      .then(j => {
        if (j.contacts) {
          setContacts(j.contacts);
          try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(j.contacts)); } catch {}
        }
      })
      .catch(() => {});
  }, []);
  const [selectedChat, setSelectedChat] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [showCalendar, setShowCalendar] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>([]);
  const [needsHumanPhones, setNeedsHumanPhones] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Track last-seen message timestamp per phone to calculate unread counts
  const lastSeenRef = useRef<Record<string, string>>({});

  // Load lastSeen from localStorage after mount
  useEffect(() => {
    try { lastSeenRef.current = JSON.parse(localStorage.getItem('kiddost_lastSeen') || '{}'); } catch {}
  }, []);

  // Fetch phones needing human attention
  const loadNeedsHuman = async () => {
    try {
      const r = await fetch(`${SERVER}/needs-human`);
      const j = await r.json();
      if (j.phones) {
        const sorted = [...j.phones].sort().join(',');
        setNeedsHumanPhones(prev => {
          const prevSorted = [...prev].sort().join(',');
          return prevSorted === sorted ? prev : new Set(j.phones);
        });
      }
    } catch {}
  };

  useEffect(() => {
    if (!authed) return;
    loadNeedsHuman();
    const iv = setInterval(loadNeedsHuman, 10000);
    return () => clearInterval(iv);
  }, [authed]);

  const agentScopedKey = `${agentId || 'no-id'}::${agentName || 'Agent'}`;

  useEffect(() => {
    if (!authed) {
      setPinnedChatIds([]);
      return;
    }
    const store = getPinnedStore();
    const scoped = Array.isArray(store[agentScopedKey]) ? store[agentScopedKey] : [];
    setPinnedChatIds(scoped);
  }, [authed, agentScopedKey]);

  const togglePinChat = (chatId: string) => {
    setPinnedChatIds((prev) => {
      const next = prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId];
      const store = getPinnedStore();
      store[agentScopedKey] = next;
      setPinnedStore(store);
      setChats((current) => current.map((c) => c.id === chatId ? { ...c, pinned: !prev.includes(chatId) } : c));
      return next;
    });
  };

  const markRead = (phone: string) => {
    lastSeenRef.current[phone] = new Date().toISOString();
    try { localStorage.setItem('kiddost_lastSeen', JSON.stringify(lastSeenRef.current)); } catch {}
  };

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const loadChats = async () => {
    // Only fetch the latest message per phone — limit to recent messages to avoid downloading entire DB
    const { data, error } = await supabase.from("messages").select("phone, content, role, sender, agent, created_at").order("created_at", { ascending: false }).limit(500);
    if (error) return;
    if (!data || data.length === 0) return setChats([]);

    // Count unread (user messages newer than last-seen) per phone
    const unreadCount: Record<string, number> = {};
    for (const row of data) {
      if (row.role !== 'user' && row.sender !== 'user') continue;
      const lastSeen = lastSeenRef.current[row.phone];
      if (!lastSeen || row.created_at > lastSeen) {
        unreadCount[row.phone] = (unreadCount[row.phone] || 0) + 1;
      }
    }

    const map = new Map();
    for (const row of data) {
      if (!map.has(row.phone)) map.set(row.phone, row);
    }

    const contacts = getContacts();
    const result: Chat[] = Array.from(map.values()).map((r: any) => ({
      id: r.phone,
      name: contacts[r.phone]?.name || r.phone,
      avatar: avatarDataUrl(contacts[r.phone]?.name || r.phone, r.phone),
      lastMessage: r.content || '',
      time: r.created_at ? new Date(r.created_at).toLocaleString() : "",
      agent: r.agent ?? null,
      unread: unreadCount[r.phone] || 0,
      lastMsgAt: r.created_at,
      labels: contacts[r.phone]?.labels || [],
      pinned: pinnedChatIds.includes(r.phone),
      needsHuman: needsHumanPhones.has(r.phone),
    }));

    setChats(result);
  };

  const loadMessages = async (phone: string) => {
    const { data, error } = await supabase.from("messages").select("*").eq("phone", phone).order("created_at", { ascending: true });
    if (error) return;
    if (!data) return setMessages([]);
    const msgs: Message[] = data.map((m: any) => {
      // prefer explicit sender column when present
      const isOther = m.sender === 'user' || m.role === 'user';
      const isSystem = m.sender === 'system' || m.role === 'system';
      return ({
        id: String(m.id || m.created_at),
        text: m.content || m.text || '',
        sender: isSystem ? 'system' : (isOther ? 'other' : 'me'),
        time: m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
        agent: m.agent ?? null,
        ai_enabled: typeof m.ai_enabled !== 'undefined' ? !!m.ai_enabled : true,
        status: m.status ?? null,
        media_url: m.media_url ?? null,
        whatsapp_id: m.whatsapp_id ?? null,
      });
    });
    setMessages(msgs);
    setTimeout(scrollToBottom, 100);
  };

  const sendingRef = useRef(false);
  const sendMessage = async (text: string) => {
    if (!text || !selectedChat || sendingRef.current) return;
    sendingRef.current = true;
    // Optimistic: show message immediately
    const optimistic: Message = {
      id: 'optimistic-' + Date.now(),
      text,
      sender: 'me',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      agent: agentName,
      status: 'sending',
      media_url: null,
      whatsapp_id: null,
    };
    setMessages(prev => [...prev, optimistic]);
    setTimeout(scrollToBottom, 50);
    try {
      await fetch(`${SERVER}/agent-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: selectedChat, message: text, agent: agentName }),
      });
    } finally {
      sendingRef.current = false;
    }
  };

  useEffect(() => {
    if (!authed) return;
    loadChats();
  }, [authed, pinnedChatIds]);

  // When needsHumanPhones changes, patch chats in-place (no refetch)
  useEffect(() => {
    setChats(prev => prev.map(c => ({ ...c, needsHuman: needsHumanPhones.has(c.id) })));
  }, [needsHumanPhones]);

  useEffect(() => {
    if (selectedChat) {
      loadMessages(selectedChat);
      markRead(selectedChat);
      // Refresh chats so unread badge clears immediately
      setChats(prev => prev.map(c => c.id === selectedChat ? { ...c, unread: 0 } : c));
    }
  }, [selectedChat]);

  useEffect(() => {
    if (!authed) return;
    const channel = supabase
      .channel("realtime-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const msg = payload.new;
          console.log('realtime:', msg.phone, msg.content?.slice(0, 30));
          if (msg.phone === selectedChat) {
            const mapped = {
              id: String(msg.id || msg.created_at),
              text: msg.content || msg.text || '',
              sender: (msg.sender === 'system' || msg.role === 'system') ? 'system' as const
                : (msg.role === 'user' || msg.sender === 'user') ? 'other' as const
                : 'me' as const,
              time: msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
              agent: msg.agent ?? null,
              ai_enabled: typeof msg.ai_enabled !== 'undefined' ? !!msg.ai_enabled : undefined,
              status: msg.status ?? null,
              media_url: msg.media_url ?? null,
              whatsapp_id: msg.whatsapp_id ?? null,
            };
            setMessages((prev) => {
              // Dedup: skip if message with same id already exists (or optimistic match)
              if (prev.some(m => m.id === mapped.id || (m.id.startsWith('optimistic-') && m.text === mapped.text && m.sender === mapped.sender))) {
                return prev.map(m => (m.id.startsWith('optimistic-') && m.text === mapped.text && m.sender === mapped.sender) ? mapped : m);
              }
              return [...prev, mapped];
            });
            setTimeout(scrollToBottom, 100);
            // Mark as read since we're looking at it
            markRead(msg.phone);
          } else if (msg.role === 'user' || msg.sender === 'user') {
            // Message for a background chat — bump its unread count
            setChats(prev => prev.map(c =>
              c.id === msg.phone ? { ...c, unread: (c.unread || 0) + 1, lastMessage: msg.content || '', time: msg.created_at ? new Date(msg.created_at).toLocaleString() : c.time, lastMsgAt: msg.created_at || c.lastMsgAt } : c
            ));
          }
          // Update the chat's lastMessage without re-fetching everything
          setChats(prev => {
            const exists = prev.some(c => c.id === msg.phone);
            if (exists) {
              return prev.map(c => c.id === msg.phone ? { ...c, lastMessage: msg.content || c.lastMessage, time: msg.created_at ? new Date(msg.created_at).toLocaleString() : c.time, lastMsgAt: msg.created_at || c.lastMsgAt, agent: msg.agent ?? c.agent } : c);
            }
            // New phone not in list — add it
            const contacts = getContacts();
            return [{ id: msg.phone, name: contacts[msg.phone]?.name || msg.phone, avatar: avatarDataUrl(contacts[msg.phone]?.name || msg.phone, msg.phone), lastMessage: msg.content || '', time: msg.created_at ? new Date(msg.created_at).toLocaleString() : '', unread: 1, agent: msg.agent ?? null, lastMsgAt: msg.created_at, labels: contacts[msg.phone]?.labels || [], pinned: false, needsHuman: false }, ...prev];
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages" },
        (payload) => {
          const msg = payload.new;
          // Patch status on matching message in state (status tick update)
          if (msg.phone === selectedChat && msg.status) {
            setMessages(prev => prev.map(m =>
              (m.whatsapp_id && m.whatsapp_id === msg.whatsapp_id) ||
              (m.id === String(msg.id))
                ? { ...m, status: msg.status }
                : m
            ));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedChat, authed]);

  // Polling fallback: refresh chats every 15s (realtime handles most updates)
  useEffect(() => {
    if (!authed) return;
    const iv = setInterval(() => {
      loadChats();
    }, 15000);

    return () => clearInterval(iv);
  }, [authed]);

  // Register service worker and subscribe to push notifications on login
  useEffect(() => {
    if (!authed) return;
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;

    async function setupPush() {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const keyRes = await fetch(`${SERVER}/vapid-public-key`);
        const { publicKey } = await keyRes.json();
        if (!publicKey) return;

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const existing = await reg.pushManager.getSubscription();
        const subscription = existing || await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });

        await fetch(`${SERVER}/push-subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription, agent: agentName })
        });
      } catch (e) {
        console.warn('Push setup failed:', e);
      }
    }

    function urlBase64ToUint8Array(base64String: string) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      return new Uint8Array([...raw].map(c => c.charCodeAt(0)));
    }

    setupPush();
  }, [authed, agentName]);

  const currentChat = chats.find((c) => c.id === selectedChat);

  const handleDeleteAccount = async () => {
    if (!agentId || !deletePin.trim()) return;
    setDeleteLoading(true); setDeleteError('');
    try {
      const res = await fetch(`${SERVER}/delete-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, pin: deletePin.trim() }),
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        setShowDeleteModal(false);
        localStorage.removeItem(SESSION_KEY);
        setAuthed(false); setAgentName('Agent'); setAgentId(null);
      } else {
        setDeleteError(json.error === 'invalid_pin' ? 'Incorrect PIN. Try again.' : 'Failed to delete account.');
      }
    } catch { setDeleteError('Connection error. Try again.'); }
    finally { setDeleteLoading(false); }
  };

  if (!authed) {
    return <LoginScreen onLogin={(name) => {
      setAuthed(true); setAgentName(name);
      try { setAgentId(JSON.parse(localStorage.getItem(SESSION_KEY) || '{}').id ?? null); } catch {}
    }} />;
  }

  return (
    <div
      className={`h-screen max-w-md mx-auto shadow-2xl ${isDarkMode ? "bg-black" : "bg-white"}`}
      style={isDarkMode ? { boxShadow: "0 0 100px rgba(59, 130, 246, 0.3)" } : { boxShadow: "0 0 50px rgba(0, 0, 0, 0.1)" }}
    >
      {showCalendar ? (
        <Calendar isDarkMode={isDarkMode} onBack={() => setShowCalendar(false)} agentName={agentName} />
      ) : (
        <div className="h-full flex flex-col overflow-hidden">
          {/* Chat List: preserved in DOM to maintain scroll position perfectly */}
          <div className={selectedChat ? "hidden" : "h-full flex flex-col"}>
            {chats.length === 0 ? (
              <div style={{ padding: 40, color: isDarkMode ? '#fff' : '#000', textAlign: 'center' }}>
                No chats yet — check DevTools console for errors.
              </div>
            ) : (
              <ChatList
                onSelectChat={(chatId) => setSelectedChat(chatId)}
                onTogglePin={togglePinChat}
                onOpenCalendar={() => setShowCalendar(true)}
                isDarkMode={isDarkMode}
                onToggleTheme={() => setIsDarkMode(!isDarkMode)}
                onLogout={() => { localStorage.removeItem(SESSION_KEY); setAuthed(false); setAgentName('Agent'); setAgentId(null); }}
                onDeleteAccount={agentId && agentId !== 'admin' ? () => { setDeletePin(''); setDeleteError(''); setShowDeleteModal(true); } : undefined}
                chats={chats}
              />
            )}
          </div>

          {/* Chat Detail: rendered conditionally on top */}
          {selectedChat && (
            <div className="h-full flex flex-col">
              <ChatDetail
                chatId={selectedChat}
                onBack={() => setSelectedChat(null)}
                isDarkMode={isDarkMode}
                messages={messages}
                chatName={currentChat?.name}
                chatAvatar={currentChat?.avatar}
                onSend={sendMessage}
                agentName={agentName}
                onSaveContact={(name, notes) => {
                  // Save to server (shared across all agents) + local state
                  fetch(`${SERVER}/contacts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: selectedChat, name, notes })
                  }).catch(() => {});
                  saveContact(selectedChat, { name, notes });
                  setContacts(prev => ({ ...prev, [selectedChat]: { name, notes } }));
                  setChats(prev => prev.map(c => c.id === selectedChat ? { ...c, name: name || c.id } : c));
                }}
                initialContact={contacts[selectedChat] || { name: '', notes: '' }}
                initialLabels={contacts[selectedChat]?.labels || []}
                onAddLabel={(label) => {
                  fetch(`${SERVER}/label`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: selectedChat, label })
                  }).catch(() => {});
                  setContacts(prev => {
                    const cur = prev[selectedChat] || { name: '', notes: '', labels: [] };
                    const newLabels = cur.labels?.includes(label) ? cur.labels : [...(cur.labels || []), label];
                    const updated = { ...prev, [selectedChat]: { ...cur, labels: newLabels } };
                    try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(updated)); } catch {}
                    setChats(chats => chats.map(c => c.id === selectedChat ? { ...c, labels: newLabels } : c));
                    return updated;
                  });
                }}
                onRemoveLabel={(label) => {
                  fetch(`${SERVER}/label?phone=${encodeURIComponent(selectedChat)}&label=${encodeURIComponent(label)}`, {
                    method: 'DELETE',
                  }).catch(() => {});
                  setContacts(prev => {
                    const cur = prev[selectedChat] || { name: '', notes: '', labels: [] };
                    const newLabels = (cur.labels || []).filter(l => l !== label);
                    const updated = { ...prev, [selectedChat]: { ...cur, labels: newLabels } };
                    try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(updated)); } catch {}
                    setChats(chats => chats.map(c => c.id === selectedChat ? { ...c, labels: newLabels } : c));
                    return updated;
                  });
                }}
              />
            </div>
          )}
        </div>
      )}
      <div ref={bottomRef} />

      {/* Delete Account Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowDeleteModal(false)}>
          <div
            className={`w-80 rounded-2xl p-6 shadow-2xl ${isDarkMode ? 'bg-gray-900 border border-red-900/40' : 'bg-white border border-red-200'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className={`text-lg font-bold mb-1 ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Delete Account</h2>
            <p className={`text-sm mb-4 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              This will permanently remove your agent account. Enter your PIN to confirm.
            </p>
            <input
              type="password"
              inputMode="numeric"
              placeholder="Enter your PIN"
              value={deletePin}
              onChange={(e) => setDeletePin(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleDeleteAccount()}
              maxLength={8}
              className={`w-full rounded-xl px-4 py-3 text-base outline-none mb-3 ${isDarkMode ? 'bg-gray-800 text-white border border-gray-700 focus:border-red-500' : 'bg-gray-100 text-gray-900 border border-gray-200 focus:border-red-400'}`}
            />
            {deleteError && <p className="text-red-500 text-xs mb-3">{deleteError}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteModal(false)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleteLoading || !deletePin.trim()}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 active:scale-95 transition-all"
              >
                {deleteLoading ? 'Deleting…' : 'Delete Account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
