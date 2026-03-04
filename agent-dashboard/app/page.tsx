"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function Home() {

  const [conversations, setConversations] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    loadConversations();
  }, []);

  async function loadConversations() {
    const { data } = await supabase
      .from("conversations")
      .select("*")
      .order("created_at", { ascending: false });

    setConversations(data || []);
  }

  async function loadMessages(phone: string) {
    setSelectedPhone(phone);

    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("phone", phone)
      .order("created_at", { ascending: true });

    setMessages(data || []);
  }

  async function sendMessage() {
    if (!text || !selectedPhone) return;

    await fetch("https://kiddost-ai.onrender.com/agent-send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        phone: selectedPhone,
        message: text
      })
    });

    setText("");

    // reload messages after sending
    loadMessages(selectedPhone);
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "Arial" }}>

      {/* LEFT PANEL */}
      <div style={{
        width: "300px",
        borderRight: "1px solid #ddd",
        padding: "20px",
        overflowY: "auto"
      }}>

        <h2>Chats</h2>

        {conversations.map((c) => (
          <div
            key={c.phone}
            onClick={() => loadMessages(c.phone)}
            style={{
              padding: "12px",
              borderBottom: "1px solid #eee",
              cursor: "pointer"
            }}
          >
            {c.phone}
          </div>
        ))}

      </div>


      {/* RIGHT PANEL */}
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column"
      }}>

        {!selectedPhone && (
          <div style={{ padding: "20px" }}>
            Select a conversation
          </div>
        )}

        {selectedPhone && (
          <>
            {/* HEADER */}
            <div style={{
              padding: "15px",
              borderBottom: "1px solid #ddd",
              fontWeight: "bold"
            }}>
              {selectedPhone}
            </div>


            {/* MESSAGE AREA */}
            <div style={{
              flex: 1,
              padding: "20px",
              overflowY: "auto",
              background: "#f5f5f5"
            }}>

              {messages.map((m) => (

                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    justifyContent:
                      m.sender === "agent" || m.sender === "ai"
                        ? "flex-end"
                        : "flex-start",
                    marginBottom: "10px"
                  }}
                >

                  <div style={{
                    padding: "10px 14px",
                    borderRadius: "10px",
                    background:
                      m.sender === "agent" || m.sender === "ai"
                        ? "#dcf8c6"
                        : "#ffffff",
                    maxWidth: "60%",
                    color: "black"
                  }}>
                    {m.content}
                  </div>

                </div>

              ))}

            </div>


            {/* INPUT AREA */}
            <div style={{
              padding: "15px",
              borderTop: "1px solid #ddd",
              display: "flex"
            }}>

              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type a message..."
                style={{
                  flex: 1,
                  padding: "10px",
                  border: "1px solid #ccc",
                  borderRadius: "6px"
                }}
              />

              <button
                onClick={sendMessage}
                style={{
                  marginLeft: "10px",
                  padding: "10px 20px",
                  background: "#25D366",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer"
                }}
              >
                Send
              </button>

            </div>

          </>
        )}

      </div>

    </div>
  );
}