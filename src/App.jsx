import {useEffect, useRef, useState} from 'react'
import './App.css'
import '@chatscope/chat-ui-kit-styles/dist/default/styles.min.css'
import {
    MainContainer,
    ChatContainer,
    MessageList,
    Message,
    MessageInput,
    TypingIndicator
} from "@chatscope/chat-ui-kit-react"

const API_KEY = import.meta.env.VITE_OPENAI_API_KEY
const STORAGE_KEY = "lazarova-chat-history-v1"


function App() {
    const [errorMsg, setErrorMsg] = useState("");
    const [isStopping, setIsStopping] = useState(false);
    const [typing, setTyping] = useState(false)
    const [messages, setMessages] = useState([
        {message: "Hello, I'm LazarovaBot! Ask me anything.", sender: "assistant", direction: "incoming"}
    ])

    // Dark / Light theme
    const [theme, setTheme] = useState(localStorage.getItem("theme") || "light");

    useEffect(() => {
        document.body.setAttribute("data-theme", theme);
        localStorage.setItem("theme", theme);
    }, [theme]);

    const toggleTheme = () => {
        setTheme((prev) => (prev === "light" ? "dark" : "light"));
    };

    const abortRef = useRef(null)

    useEffect(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEY)
            if (saved) {
                const parsed = JSON.parse(saved)
                if (Array.isArray(parsed) && parsed.length) setMessages(parsed)
            }
        } catch {
        }
    }, [])

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
        } catch {
        }
    }, [messages])


    const sendMessage = async (text) => {
        const newUserMsg = {message: text, sender: "user", direction: "outgoing"}
        setMessages(prev => [...prev, newUserMsg])
        setTyping(true)
        await processMessage(newUserMsg)
    }

    // ---- (#3) Историја: последни 6 пораки + системска улога ----
    const toChatHistory = (allMsgs) => {
        const system = {role: "system", content: "Explain all concepts in advanced level of speaking."}
        const recent = allMsgs.slice(-6).map(m => ({
            role: m.sender === "assistant" ? "assistant" : "user",
            content: m.message
        }))
        return [system, ...recent]
    }

    // ---- (#1, #4) Модел + цврст error handling ----
    async function processMessage(newUserMsg) {
        try {
            if (!API_KEY) {
                setMessages(prev => [...prev, {
                    message: "⚠️ Missing API key (VITE_OPENAI_API_KEY).",
                    sender: "assistant",
                    direction: "incoming",
                }])
                setTyping(false)
                return
            }

            const apiRequestBody = {
                model: "gpt-4o-mini",
                messages: toChatHistory([...messages, newUserMsg]) // (#3)
            }

            abortRef.current = new AbortController() //every time we send message ,new AbortController is created

            const resp = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(apiRequestBody),
                signal: abortRef.current.signal
            })

            // graceful handling за 401/429/400 ...
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}))
                const msg = err?.error?.message || `API error ${resp.status}`
                setMessages(prev => [...prev, {message: `⚠️ ${msg}`, sender: "assistant", direction: "incoming"}]);
                setErrorMsg(`⚠️ ${msg}`);
                setTimeout(() => setErrorMsg(""), 3000);
                setTyping(false);
                return
            }

            const data = await resp.json()
            //  console.log("FULL API RESPONSE:", data); //making sure choices is working
            const content = data?.choices?.[0]?.message?.content || "(no content)"
            setMessages(prev => [...prev, {message: content, sender: "assistant", direction: "incoming", source: "openai"}])
        } catch (e) {
            if (String(e?.name) === "AbortError") {
                // корисникот притисна Stop
                setMessages(prev => [...prev, {message: "⏹️ Stopped.", sender: "assistant", direction: "incoming"}]);
            } else {
                const msg = `Network/JS error: ${String(e).slice(0, 120)}`;
                setMessages(prev => [...prev, {message: `⚠️ ${msg}`, sender: "assistant", direction: "incoming"}]);
                setErrorMsg(`⚠️ ${msg}`);
                setTimeout(() => setErrorMsg(""), 3000);
            }
        } finally {
            setTyping(false);
            setIsStopping(false);
            abortRef.current = null;
        }
    }

    const clearChat = () => {
        setMessages([{message: "New session started. How can I help?", sender: "assistant", direction: "incoming"}])
    }

    const stopGenerating = () => {
        if (abortRef.current) {
            setIsStopping(true);
            abortRef.current.abort();
        }
    };

    // Extract a concise Wikipedia-ready topic using OpenAI (mini NLP)
    async function extractTopicWithAI(text) {
        try {
            const body = {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content:
                            "You are a topic extractor. From the user's message, return ONLY the main topic as a Wikipedia page title. " +
                            "Prefer the most canonical title (e.g., 'Alexander the Great', 'Quantum computing'). " +
                            "If multiple topics exist, pick the single most likely primary topic. " +
                            "Return plain text only, no quotes, no punctuation, no explanations. " +
                            "If you cannot determine, return UNKNOWN."
                    },
                    {role: "user", content: String(text).slice(0, 500)}
                ],
                temperature: 0.2,
                max_tokens: 24
            };

            const resp = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body)
            });

            if (!resp.ok) {
                // fallback to simple heuristics if API fails
                return null;
            }

            const data = await resp.json();
            const topic = data?.choices?.[0]?.message?.content?.trim();
            if (!topic || topic.toUpperCase() === "UNKNOWN") return null;
            return topic;
        } catch {
            return null;
        }
    }


    const searchWikipedia = async () => {
        try {
            // 1) земи последна user порака
            const lastUserMsg = [...messages].reverse().find(m => m.sender === "user");
            if (!lastUserMsg) {
                setMessages(prev => [...prev, {
                    message: "⚠️ No user message to search.",
                    sender: "assistant",
                    direction: "incoming",
                    source: "wiki"
                }]);
                return;
            }

            setTyping(true);

            // 2) mini NLP extraction преку OpenAI
            let topic = await extractTopicWithAI(lastUserMsg.message);

            // 3) robust fallback (regex + capitalized entity guess)
            if (!topic) {
                const raw = lastUserMsg.message.trim();
                let cleaned = raw
                    .replace(/^(tell me about|what is|who is|explain|define|show me|describe|give me info about)\s+/i, "")
                    .replace(/[\?\.\!]+$/g, "")
                    .trim();
                if (cleaned.split(" ").length > 6) {
                    const m = cleaned.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/);
                    if (m) cleaned = m[0];
                }
                topic = cleaned || raw;
            }

            // 4) Прво Wikipedia search за најрелевантен наслов
            const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&format=json&origin=*`;
            const sres = await fetch(searchUrl);
            if (!sres.ok) throw new Error("Wikipedia search failed");
            const sdata = await sres.json();
            const title = sdata?.query?.search?.[0]?.title;

            if (!title) {
                setMessages(prev => [...prev, {
                    message: `⚠️ No Wikipedia results for: ${topic}`,
                    sender: "assistant",
                    direction: "incoming",
                    source: "wiki"
                }]);
                return;
            }

            // 5) Потоа точниот summary
            const sumUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
            const r = await fetch(sumUrl);
            if (!r.ok) throw new Error("Wikipedia summary fetch failed");
            const data = await r.json();

            const summary = data.extract || "No summary found for that topic.";
            setMessages(prev => [
                ...prev,
                {
                    message: `📚 Wikipedia summary for **${data.title}**:\n\n${summary}`,
                    sender: "assistant",
                    direction: "incoming",
                    source: "wiki"
                }
            ]);
        } catch (e) {
            setMessages(prev => [...prev, {
                message: `⚠️ Error fetching Wikipedia data: ${e.message}`,
                sender: "assistant",
                direction: "incoming",
                source: "wiki"
            }]);
        } finally {
            setTyping(false);
        }
    };


    return (
        <div className='App'>
            {/* Toolbar со копчиња */}
            <div style={{
                maxWidth: "750px",
                margin: "10px auto",
                display: "flex",
                gap: "8px",
                justifyContent: "flex-end",
                alignItems: "center"
            }}>
                <button
                    onClick={searchWikipedia}
                    style={{
                        padding: "6px 12px",
                        backgroundColor: "#10b981",
                        color: "white",
                        border: "none",
                        borderRadius: "8px",
                        cursor: "pointer",
                        fontSize: "14px"
                    }}
                >
                    🔍 Search Context
                </button>

                <button
                    onClick={toggleTheme}
                    style={{
                        padding: "6px 12px",
                        backgroundColor: theme === "dark" ? "#facc15" : "#1e293b",
                        color: theme === "dark" ? "#000" : "#fff",
                        border: "none",
                        borderRadius: "8px",
                        cursor: "pointer",
                        fontSize: "14px"
                    }}
                >
                    {theme === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode"}
                </button>

                <button
                    onClick={stopGenerating}
                    disabled={!typing}
                    style={{
                        padding: "6px 12px",
                        backgroundColor: typing ? "#ef4444" : "#9ca3af",
                        color: "white",
                        border: "none",
                        borderRadius: "8px",
                        cursor: typing ? "pointer" : "not-allowed",
                        fontSize: "14px"
                    }}
                >
                    {isStopping ? "Stopping…" : "⏹ Stop"}
                </button>

            </div>

            {/* Toolbar со копче за Clear Chat */}
            <div style={{
                maxWidth: "750px",
                margin: "10px auto",
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center"
            }}>
                <button
                    onClick={clearChat}
                    style={{
                        padding: "6px 12px",
                        backgroundColor: "#2563eb",
                        color: "white",
                        border: "none",
                        borderRadius: "8px",
                        cursor: "pointer",
                        fontSize: "14px"
                    }}
                >
                    🧹 Clear chat
                </button>
            </div>

            <div style={{height: "85vh", width: "750px"}}>
                <MainContainer>
                    <ChatContainer>
                        <MessageList
                            typingIndicator={typing ? <TypingIndicator content="Assistant is typing..."/> : null}>
                            {messages.map((m, i) => (
                                <div key={i} className="msg-wrap">
                                    <Message model={m}/>
                                    {m.sender === "assistant" && m.source && (
                                        <div className={`chip ${m.source === "wiki" ? "chip-wiki" : "chip-openai"}`}>
                                            {m.source === "wiki" ? "Wikipedia" : "OpenAI"}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </MessageList>

                        <MessageInput placeholder='Type message here' onSend={sendMessage}/>
                    </ChatContainer>
                </MainContainer>
            </div>
        </div>
    )
}

export default App
