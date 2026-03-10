"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChatList } from "./components/ChatList";
import { ChatDetail } from "./components/ChatDetail";
import "./mobile-styles.css";
import { avatarDataUrl } from './avatarDataUrl';
import { supabase } from "../lib/supabase";

type Chat = { id: string; name: string; avatar: string; lastMessage: string; time: string; unread?: number };
type Message = { id: string; text: string; sender: "me" | "other"; time: string; agent?: string | null; ai_enabled?: boolean; status?: string | null; media_url?: string | null; whatsapp_id?: string | null };

export default function AppClient() {
  const [selectedChat, setSelectedChat] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const loadChats = async () => {
    const { data, error } = await supabase.from("messages").select("phone, content, created_at").order("created_at", { ascending: false });
    console.log('loadChats result', { data, error });
    if (error) return;
    if (!data || data.length === 0) return setChats([]);

    const map = new Map();
    for (const row of data) {
      if (!map.has(row.phone)) map.set(row.phone, row);
    }

    const result: Chat[] = Array.from(map.values()).map((r: any) => ({
      id: r.phone,
      name: r.phone,
      avatar: avatarDataUrl(r.phone),
      lastMessage: r.content || "",
      time: r.created_at ? new Date(r.created_at).toLocaleString() : "",
    }));

    setChats(result);
    if (!selectedChat && result.length > 0) setSelectedChat(result[0].id);
  };

  const loadMessages = async (phone: string) => {
    const { data, error } = await supabase.from("messages").select("*").eq("phone", phone).order("created_at", { ascending: true });
    console.log('loadMessages result', { phone, data, error });
    if (error) return;
    if (!data) return setMessages([]);
    const msgs: Message[] = data.map((m: any) => ({
      id: String(m.id || m.created_at),
      text: m.content || m.text || '',
      sender: ((m.role && m.role === 'user') ? 'other' : 'me') as 'me' | 'other',
      time: m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      agent: m.agent ?? null,
      ai_enabled: typeof m.ai_enabled !== 'undefined' ? !!m.ai_enabled : true,
      status: m.status ?? null,
      media_url: m.media_url ?? null,
      whatsapp_id: m.whatsapp_id ?? null,
    }));
    setMessages(msgs);
    setTimeout(scrollToBottom, 100);
  };

  const sendMessage = async (text: string) => {
    if (!text || !selectedChat) return;

    await fetch("https://kiddost-ai.onrender.com/agent-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: selectedChat, message: text, agent: 'Daksh' }),
    });
  };

  useEffect(() => {
    loadChats();
  }, []);

  useEffect(() => {
    if (selectedChat) loadMessages(selectedChat);
  }, [selectedChat]);

  useEffect(() => {
    const channel = supabase
      .channel("realtime-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          console.log('realtime payload:', payload);
          const msg = payload.new;
          if (msg.phone === selectedChat) {
            const mapped = {
              id: String(msg.id || msg.created_at),
              text: msg.content || msg.text || '',
              sender: ((msg.role && msg.role === 'user') ? 'other' : 'me') as 'me' | 'other',
              time: msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
              agent: msg.agent ?? null,
              ai_enabled: typeof msg.ai_enabled !== 'undefined' ? !!msg.ai_enabled : true,
              status: msg.status ?? null,
              media_url: msg.media_url ?? null,
              whatsapp_id: msg.whatsapp_id ?? null,
            };
            setMessages((prev) => [...prev, mapped]);
            setTimeout(scrollToBottom, 100);
          }
          loadChats();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedChat]);

  // Polling fallback: refresh chats/messages every 5s
  useEffect(() => {
    const iv = setInterval(() => {
      loadChats();
      if (selectedChat) loadMessages(selectedChat);
    }, 5000);

    return () => clearInterval(iv);
  }, [selectedChat]);

  const currentChat = chats.find((c) => c.id === selectedChat);

  return (
    <div
      className={`h-screen max-w-md mx-auto shadow-2xl ${isDarkMode ? "bg-black" : "bg-white"}`}
      style={isDarkMode ? { boxShadow: "0 0 100px rgba(59, 130, 246, 0.3)" } : { boxShadow: "0 0 50px rgba(0, 0, 0, 0.1)" }}
    >
      {selectedChat ? (
        <ChatDetail
          chatId={selectedChat}
          onBack={() => setSelectedChat(null)}
          isDarkMode={isDarkMode}
          messages={messages}
          chatName={currentChat?.name}
          chatAvatar={currentChat?.avatar}
          onSend={sendMessage}
        />
      ) : (
        chats.length === 0 ? (
          <div style={{ padding: 40, color: isDarkMode ? '#fff' : '#000', textAlign: 'center' }}>
            No chats yet — check DevTools console for errors.
          </div>
        ) : (
          <ChatList
            onSelectChat={(chatId) => setSelectedChat(chatId)}
            isDarkMode={isDarkMode}
            onToggleTheme={() => setIsDarkMode(!isDarkMode)}
            chats={chats}
          />
        )
      )}
      <div ref={bottomRef} />
    </div>
  );
}
