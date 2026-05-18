"use client";

import { useState } from "react";
import { Search, Moon, Sun, LogOut, Trash2, PenSquare, X, Pin, CalendarDays } from "lucide-react";

const SERVER = 'https://kiddost-ai.onrender.com';

const KNOWN_TEMPLATES = [
  { id: 'session', name: 'Session Today?', body: 'Hi, Would you like to go ahead with the session today?' },
];

interface Chat {
  id: string;
  name: string;
  avatar: string;
  lastMessage: string;
  time: string;
  unread?: number;
  agent?: string | null;
  labels?: string[];
  pinned?: boolean;
  needsHuman?: boolean;
  lastMsgAt?: string | null;
}

interface ChatListProps {
  onSelectChat: (chatId: string) => void;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  onLogout: () => void;
  onDeleteAccount?: () => void;
  chats: Chat[];
  onTogglePin: (chatId: string) => void;
  onOpenCalendar: () => void;
  allRecentMessages?: any[];
}

export function ChatList({ onSelectChat, isDarkMode, onToggleTheme, onLogout, onDeleteAccount, chats, onTogglePin, onOpenCalendar, allRecentMessages = [] }: ChatListProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<'latest' | 'az' | 'agent'>('latest');
  const [showNewConvo, setShowNewConvo] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newTemplateSending, setNewTemplateSending] = useState(false);
  const [newConvoError, setNewConvoError] = useState('');
  const [newConvoSuccess, setNewConvoSuccess] = useState(false);

  const formatPhone = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
    if (digits.length === 10) return `+91${digits}`;
    return raw.startsWith('+') ? raw : `+${digits}`;
  };

  const sendNewConvo = async (templateId: string) => {
    const phone = formatPhone(newPhone.trim());
    if (!phone || newTemplateSending) return;
    setNewTemplateSending(true);
    setNewConvoError('');
    try {
      const res = await fetch(`${SERVER}/send-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, templateId, variables: [] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed');
      setNewConvoSuccess(true);
      setTimeout(() => { setShowNewConvo(false); setNewPhone(''); setNewConvoSuccess(false); }, 1500);
    } catch (e: any) {
      setNewConvoError(e.message || 'Could not send');
    } finally {
      setNewTemplateSending(false);
    }
  };

  const filtered = query.trim()
    ? chats.filter((c) => {
        const queryLower = query.toLowerCase();
        // 1. Search contact name
        if (c.name.toLowerCase().includes(queryLower)) return true;
        // 2. Search last message
        if (c.lastMessage.toLowerCase().includes(queryLower)) return true;
        // 3. Search past messages in allRecentMessages history
        const hasPastMatch = allRecentMessages.some(
          (m) =>
            m.phone === c.id &&
            m.content &&
            m.content.toLowerCase().includes(queryLower)
        );
        return hasPastMatch;
      })
    : chats;

  const baseSorted = sort === 'az'
    ? [...filtered].sort((a, b) => a.name.localeCompare(b.name))
    : sort === 'agent'
    ? [...filtered].sort((a, b) => (a.agent || 'AI').localeCompare(b.agent || 'AI'))
    : filtered;

  const sorted = [...baseSorted].sort((a, b) => {
    // 1. Pinned chats always go to the top
    if (a.pinned !== b.pinned) return Number(!!b.pinned) - Number(!!a.pinned);
    
    // 2. Otherwise sort strictly by latest message time (most recent first)
    const timeA = a.lastMsgAt ? new Date(a.lastMsgAt).getTime() : 0;
    const timeB = b.lastMsgAt ? new Date(b.lastMsgAt).getTime() : 0;
    
    return timeB - timeA;
  });

  return (
    <div className={`flex flex-col h-full ${isDarkMode ? "bg-black" : "bg-white"}`}>
      {/* Header */}
      <div className={`text-white px-4 py-4 relative overflow-hidden ${
        isDarkMode
          ? "bg-gray-950 border-b border-blue-900/30"
          : "bg-[#008069]"
      }`}>
        <div className="flex items-center justify-between">
          <button
            onClick={onLogout}
            title="Logout"
            className={`p-2 rounded-full transition-all ${
              isDarkMode ? "hover:bg-blue-900/30 text-gray-400 hover:text-white" : "hover:bg-white/10"
            }`}
          >
            <LogOut className="w-5 h-5" />
          </button>
          {onDeleteAccount && (
            <button
              onClick={onDeleteAccount}
              title="Delete Account"
              className={`p-2 rounded-full transition-all ${
                isDarkMode ? "hover:bg-red-900/30 text-red-500/70 hover:text-red-400" : "hover:bg-red-500/10 text-red-300 hover:text-red-200"
              }`}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <h1 className="text-xl flex-1 text-center">Chats</h1>
          <button
            onClick={onOpenCalendar}
            title="Calendar"
            className={`p-2 rounded-full transition-all ${
              isDarkMode ? "hover:bg-blue-900/30 text-gray-400 hover:text-white" : "hover:bg-white/10"
            }`}
          >
            <CalendarDays className="w-5 h-5" />
          </button>
          <button
            onClick={() => { setShowNewConvo(true); setNewPhone(''); setNewConvoError(''); setNewConvoSuccess(false); }}
            title="New conversation"
            className={`p-2 rounded-full transition-all ${
              isDarkMode ? "hover:bg-blue-900/30 text-gray-400 hover:text-white" : "hover:bg-white/10"
            }`}
          >
            <PenSquare className="w-5 h-5" />
          </button>
          <button
            onClick={onToggleTheme}
            className={`p-2 rounded-full transition-all ${
              isDarkMode ? "hover:bg-blue-900/30" : "hover:bg-white/10"
            }`}
          >
            {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className={`px-4 py-3 ${
        isDarkMode
          ? "bg-gradient-to-b from-gray-900 to-black border-b border-blue-900/30"
          : "bg-white border-b border-gray-200"
      }`}>
        <div className={`flex items-center rounded-xl px-4 py-2.5 ${
          isDarkMode
            ? "bg-gray-900/50 border border-blue-500/20 backdrop-blur-sm"
            : "bg-gray-100"
        }`}>
          <Search className={`w-5 h-5 ${isDarkMode ? "text-blue-400" : "text-gray-500"}`} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isDarkMode ? "Search transmissions..." : "Search or start new chat"}
            className={`flex-1 ml-3 bg-transparent outline-none text-sm ${
              isDarkMode ? "text-gray-300 placeholder:text-gray-600" : "text-gray-900 placeholder:text-gray-500"
            }`}
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-gray-500 hover:text-gray-300 text-xs ml-2">✕</button>
          )}
        </div>
        {/* Sort pills */}
        <div className="flex gap-2 mt-2">
          {(['latest', 'az', 'agent'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={`text-xs px-3 py-1 rounded-full transition-all ${
                sort === s
                  ? isDarkMode ? 'bg-blue-600 text-white' : 'bg-[#008069] text-white'
                  : isDarkMode ? 'bg-gray-800 text-gray-400 hover:text-white' : 'bg-gray-200 text-gray-600'
              }`}
            >
              {s === 'latest' ? 'Latest' : s === 'az' ? 'A – Z' : 'Agent'}
            </button>
          ))}
        </div>
      </div>

      {/* Chat List */}
      <div className={`flex-1 overflow-y-auto ${isDarkMode ? "bg-black" : "bg-white"}`}>
        {sorted.length === 0 && (
          <p className={`text-center text-sm mt-10 ${isDarkMode ? "text-gray-600" : "text-gray-400"}`}>
            {query ? "No chats match your search." : "No chats yet."}
          </p>
        )}
        {sorted.map((chat) => (
          <div
            key={chat.id}
            onClick={() => onSelectChat(chat.id)}
            className={`flex items-center px-4 py-4 cursor-pointer transition-all duration-200 ${
              isDarkMode
                ? "border-b border-blue-900/20 hover:bg-gradient-to-r hover:from-blue-950/50 hover:to-transparent active:from-blue-900/50"
                : "border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100"
            }`}
          >
            <div className="relative">
              <img src={chat.avatar} alt={chat.name} className="w-14 h-14 rounded-full object-cover" />
              {chat.needsHuman && (
                <span className="absolute top-0 right-0 w-3.5 h-3.5 bg-red-500 rounded-full border-2 border-current"
                  style={{ borderColor: isDarkMode ? '#000' : '#fff', boxShadow: '0 0 8px rgba(239,68,68,0.7)' }} />
              )}
            </div>
            <div className="flex-1 ml-4 min-w-0">
              <div className="flex justify-between items-baseline">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className={`font-bold truncate ${isDarkMode ? "text-gray-100" : "text-gray-900"}`}>{chat.name}</h3>
                  {chat.pinned && <Pin className={`w-3.5 h-3.5 flex-shrink-0 ${isDarkMode ? 'text-yellow-300' : 'text-amber-500'}`} fill="currentColor" />}
                </div>
                <span className={`text-xs ml-2 flex-shrink-0 ${isDarkMode ? "text-blue-400" : "text-gray-500"}`}>{chat.time}</span>
              </div>
              <div className="flex justify-between items-center mt-1.5">
                <p className={`text-sm truncate ${isDarkMode ? "text-gray-500" : "text-gray-600"}`}>{chat.lastMessage}</p>
                <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onTogglePin(chat.id); }}
                    title={chat.pinned ? "Unpin chat" : "Pin chat"}
                    className={`p-1.5 rounded-full transition-all ${
                      chat.pinned
                        ? isDarkMode ? 'bg-yellow-500/20 text-yellow-300' : 'bg-amber-100 text-amber-600'
                        : isDarkMode ? 'text-gray-500 hover:text-yellow-300 hover:bg-yellow-500/10' : 'text-gray-400 hover:text-amber-600 hover:bg-amber-50'
                    }`}
                  >
                    <Pin className="w-3.5 h-3.5" fill={chat.pinned ? 'currentColor' : 'none'} />
                  </button>
                  {chat.agent && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      isDarkMode ? 'bg-blue-900/50 text-blue-300 border border-blue-700/40' : 'bg-gray-100 text-gray-600'
                    }`}>{chat.agent}</span>
                  )}
                  {chat.unread ? (
                    <span className={`text-white text-xs rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 ${
                      isDarkMode ? "bg-gradient-to-r from-blue-500 to-cyan-500" : "bg-[#25d366]"
                    }`} style={isDarkMode ? { boxShadow: '0 0 15px rgba(59, 130, 246, 0.7)' } : {}}>
                      {chat.unread}
                    </span>
                  ) : null}
                </div>
              </div>
              {chat.labels && chat.labels.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {chat.labels.map(l => (
                    <span key={l} className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                      isDarkMode ? 'bg-blue-900/40 text-blue-300' : 'bg-green-100 text-green-700'
                    }`}>{l}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* New Conversation Modal */}
      {showNewConvo && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowNewConvo(false)}>
          <div
            className={`w-full max-w-md rounded-t-2xl p-6 pb-10 shadow-2xl flex flex-col gap-4 ${
              isDarkMode ? 'bg-gray-900 border-t border-blue-900/40' : 'bg-white border-t border-gray-200'
            }`}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className={`font-semibold text-base ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>New Conversation</h2>
              <button onClick={() => setShowNewConvo(false)} className="hover:opacity-70">
                <X className={`w-5 h-5 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} />
              </button>
            </div>
            <div>
              <label className={`text-xs font-semibold mb-1.5 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>PHONE NUMBER</label>
              <input
                type="tel"
                value={newPhone}
                onChange={e => { setNewPhone(e.target.value); setNewConvoError(''); }}
                placeholder="9606746900 or +919606746900"
                className={`w-full rounded-xl px-4 py-3 text-base outline-none ${
                  isDarkMode ? 'bg-gray-800 border border-blue-500/30 text-white placeholder:text-gray-600 focus:border-blue-500' : 'bg-gray-100 border border-gray-200 text-gray-900 focus:border-[#008069]'
                }`}
              />
            </div>
            <button
              onClick={() => {
                const phone = formatPhone(newPhone.trim());
                if (!phone) return;
                setShowNewConvo(false);
                setNewPhone('');
                onSelectChat(phone);
              }}
              disabled={!newPhone.trim()}
              className={`w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all ${
                isDarkMode ? 'bg-gray-800 border border-blue-500/30 text-blue-300 hover:bg-gray-700' : 'bg-gray-100 border border-gray-200 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Open Chat
            </button>
            <div>
              <label className={`text-xs font-semibold mb-2 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>SEND TEMPLATE</label>
              <div className="flex flex-col gap-2">
                {KNOWN_TEMPLATES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => sendNewConvo(t.id)}
                    disabled={!newPhone.trim() || newTemplateSending || newConvoSuccess}
                    className={`w-full text-left rounded-xl px-4 py-3 border transition-all disabled:opacity-40 ${
                      isDarkMode ? 'bg-gray-800 border-blue-900/40 hover:border-blue-500/60 text-white' : 'bg-gray-50 border-gray-200 hover:border-[#008069] text-gray-900'
                    }`}
                  >
                    <p className="text-sm font-medium">{newConvoSuccess ? '✓ Sent!' : newTemplateSending ? 'Sending…' : t.name}</p>
                    <p className={`text-xs mt-0.5 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.body}</p>
                  </button>
                ))}
              </div>
            </div>
            {newConvoError && <p className="text-red-400 text-xs">{newConvoError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

