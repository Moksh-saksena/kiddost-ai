"use client";

import React, { useEffect, useState } from "react";
import { avatarDataUrl } from '../avatarDataUrl';
import { ArrowLeft, Send, MoreVertical, Check, CheckCheck } from "lucide-react";
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

export function ChatDetail({ chatId, onBack, isDarkMode, messages: propMessages = [], chatName, chatAvatar, onSend }: ChatDetailProps & { messages?: Message[]; chatName?: string; chatAvatar?: string; onSend: (text: string) => Promise<void> }) {
  const [messages, setMessages] = useState<Message[]>(propMessages || []);
  const [inputValue, setInputValue] = useState("");

  useEffect(() => {
    setMessages(propMessages || []);
  }, [propMessages]);

  const handleSend = async () => {
    if (inputValue.trim()) {
      await onSend(inputValue.trim());
      setInputValue("");
    }
  };

  const uploadMedia = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Direct upload to Supabase Storage (public bucket) to avoid server proxy limits
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9.\-_\.]/g, "_");
      const path = `${chatId}/${Date.now()}_${safeName}`;
      const { data: uploadData, error: uploadErr } = await supabase.storage.from('media').upload(path, file, { cacheControl: '3600', upsert: false });
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
              body: JSON.stringify({ fileBase64: base64, fileName: file.name, phone: chatId })
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

  const [aiEnabledLocal, setAiEnabledLocal] = useState<boolean>(() => {
    const lm = messages && messages.length > 0 ? messages[messages.length - 1] : null;
    return lm && typeof lm.ai_enabled !== 'undefined' ? !!lm.ai_enabled : true;
  });
  const [handlerLocal, setHandlerLocal] = useState<string>(() => {
    const lm = messages && messages.length > 0 ? messages[messages.length - 1] : null;
    return lm && lm.agent ? lm.agent : (lm && lm.ai_enabled === false ? 'Agent' : 'AI 🤖');
  });

  // sync local handler/ai state when messages prop updates
  React.useEffect(() => {
    const lastNonSystem = [...messages].reverse().find((m) => m.sender !== 'system') || null;
    if (lastNonSystem) {
      setAiEnabledLocal(typeof lastNonSystem.ai_enabled !== 'undefined' ? !!lastNonSystem.ai_enabled : true);
      setHandlerLocal(lastNonSystem.agent ? lastNonSystem.agent : (lastNonSystem.ai_enabled === false ? 'Agent' : 'AI 🤖'));
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
        // optimistic local update (do not insert visible system message)
        setAiEnabledLocal(!!enable);
        setHandlerLocal(enable ? 'AI 🤖' : 'Agent');
      }
    } catch (err) {
      console.error("toggleAi error", err);
    }
  };

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
            {handlerLocal === 'AI 🤖' ? (
              <button onClick={() => toggleAi(false)} className="ml-2 px-2 py-1 text-xs rounded bg-red-600 text-white">Stop AI</button>
            ) : (
              <button onClick={() => toggleAi(true)} className="ml-2 px-2 py-1 text-xs rounded bg-green-600 text-white">Resume AI</button>
            )}
          </div>
        </div>
        <button className={`relative z-10 ${isDarkMode ? "hover:scale-110" : ""} transition-transform`}>
          <MoreVertical className="w-6 h-6" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 relative z-10">
        {messages.filter(m => m.sender !== 'system').map((message) => {
          const isMe = message.sender === 'me';
          return (
            <div key={message.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${isDarkMode ? (isMe ? 'bg-gradient-to-r from-blue-800 to-blue-700 text-white backdrop-blur-sm' : 'bg-gray-900/80 text-gray-100 border border-blue-500/20 backdrop-blur-sm') : (isMe ? 'bg-[#d9fdd3]' : 'bg-white')}`} style={isDarkMode ? (isMe ? { boxShadow: '0 0 15px rgba(37, 99, 235, 0.2)' } : { boxShadow: '0 0 15px rgba(59, 130, 246, 0.1)' }) : {}}>
                {message.media_url && (
                  <div className="mb-2">
                    {message.media_url.endsWith('.pdf') ? (
                      <a href={message.media_url} target="_blank" rel="noreferrer" className="text-sm underline">View document</a>
                    ) : (
                      <img src={message.media_url} alt="media" className="w-48 rounded-md object-cover" />
                    )}
                  </div>
                )}
                {message.text ? <p className={`text-sm ${isDarkMode ? '' : 'text-gray-900'}`}>{message.text}</p> : null}
                <div className={`flex items-center justify-end gap-1 mt-1.5 text-xs ${isDarkMode ? (isMe ? 'text-blue-200' : 'text-blue-400') : 'text-gray-500'}`}>
                  <span>{message.time}</span>
                  {isMe && (
                    message.status === 'delivered' || message.status === 'read' ? (
                      <CheckCheck className={`w-4 h-4 ${message.status === 'read' ? 'text-blue-400' : ''}`} />
                    ) : (
                      <Check className="w-4 h-4" />
                    )
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className={`px-4 py-3 flex items-center gap-3 relative z-10 ${isDarkMode ? "bg-gradient-to-t from-gray-900 to-black border-t border-blue-900/30" : "bg-[#f0f0f0]"}`}>
        <label className="cursor-pointer">
          <input type="file" onChange={uploadMedia} className="hidden" />
          <div className={`px-3 py-2 rounded-full ${isDarkMode ? 'bg-gray-800 text-white' : 'bg-white text-gray-700'}`}>+</div>
        </label>
        <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyPress={handleKeyPress} placeholder={isDarkMode ? "Transmit message..." : "Type a message"} className={`flex-1 rounded-full px-5 py-3 outline-none text-sm ${isDarkMode ? "bg-gray-900/70 border border-blue-500/30 text-gray-100 placeholder:text-gray-600 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 backdrop-blur-sm" : "bg-white text-gray-900"} transition-all`} />
        <button onClick={handleSend} className={`p-3 rounded-full active:scale-95 transition-all ${isDarkMode ? "bg-gradient-to-r from-blue-800 to-blue-700 text-white hover:from-blue-700 hover:to-blue-600" : "bg-[#008069] text-white hover:bg-[#017a5f]"}`} style={isDarkMode ? { boxShadow: "0 0 15px rgba(37, 99, 235, 0.3)" } : {}}>
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
