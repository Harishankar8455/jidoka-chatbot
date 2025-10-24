import React, { useState, useEffect, useRef } from "react";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

function App() {
  const [input, setInput] = useState("");
  const [conversation, setConversation] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [streamingMessage, setStreamingMessage] = useState(null);
  const conversationEndRef = useRef(null);

  const scrollToBottom = () => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [conversation, streamingMessage]);

  // Typing effect for streaming messages
  useEffect(() => {
    if (streamingMessage && streamingMessage.content.length < streamingMessage.fullContent.length) {
      const timer = setTimeout(() => {
        setStreamingMessage(prev => ({
          ...prev,
          content: prev.fullContent.slice(0, prev.content.length + 1)
        }));
      }, 10); // Adjust typing speed here (lower = faster)

      return () => clearTimeout(timer);
    } else if (streamingMessage && streamingMessage.content.length === streamingMessage.fullContent.length) {
      // When typing is complete, add to conversation
      setConversation(prev => [...prev, {
        role: "assistant",
        content: streamingMessage.fullContent
      }]);
      setStreamingMessage(null);
    }
  }, [streamingMessage]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    setLoading(true);
    setError("");

    // Add user message to conversation
    const userMessage = { role: "user", content: input };
    setConversation((prev) => [...prev, userMessage]);

    try {
      const response = await axios.post("http://localhost:5000/api/query", {
        question: input,
      });

      // Start streaming the response
      setStreamingMessage({
        role: "assistant",
        content: "",
        fullContent: response.data.response
      });

    } catch (err) {
      console.error("Error querying agent:", err);
      setError("Failed to get response from AI agent. Please try again.");

      // Add error message to conversation
      const errorMessage = {
        role: "assistant",
        content: "Sorry, I encountered an error processing your request. Please try again.",
      };
      setConversation((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
      setInput("");
    }
  };

  const clearConversation = () => {
    setConversation([]);
    setStreamingMessage(null);
    setError("");
  };

  // Custom renderers for ReactMarkdown
  const MarkdownComponents = {
    table: ({ node, ...props }) => (
      <div className="table-container">
        <table className="markdown-table" {...props} />
      </div>
    ),
    th: ({ node, ...props }) => <th className="markdown-th" {...props} />,
    td: ({ node, ...props }) => <td className="markdown-td" {...props} />,
    h1: ({ node, ...props }) => <h3 className="markdown-h3" {...props} />,
    h2: ({ node, ...props }) => <h4 className="markdown-h4" {...props} />,
    h3: ({ node, ...props }) => <h5 className="markdown-h5" {...props} />,
    strong: ({ node, ...props }) => <strong className="markdown-strong" {...props} />,
  };

  const renderMessageContent = (content, isStreaming = false) => {
    // For streaming messages, we need to handle incomplete markdown
    if (isStreaming) {
      return (
        <div className="streaming-content">
          {content}
          <span className="typing-cursor">|</span>
        </div>
      );
    }

    // Check if content contains markdown-like formatting
    if (content.includes('|') && content.includes('-') && content.includes('**')) {
      return (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={MarkdownComponents}
        >
          {content}
        </ReactMarkdown>
      );
    }

    // For simple text without markdown
    return content;
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Production Data AI Assistant</h1>
        <p>
          Ask questions about production reports, defects, and performance
          metrics
        </p>
      </header>

      <div className="chat-container">
        <div className="conversation">
          {conversation.length === 0 && !streamingMessage ? (
            <div className="empty-state">
              <p>Welcome to the Production Data Assistant!</p>
              <p>Try asking questions like:</p>
              <ul>
                <li>`Show inspection summary of the component 'Component_Name'`</li>
                <li>`What is the status of "9PLY_NORMAL"?`</li>
                <li>`Give me the production data for 24th feb?`</li>
                <li>`Show me the production report for the shift A`</li>
              </ul>
            </div>
          ) : (
            <>
              {conversation.map((message, index) => (
                <div key={index} className={`message ${message.role}`}>
                  <div className="message-content">
                    {message.role === "user" ? (
                      <strong>You: </strong>
                    ) : (
                      <strong>Assistant: </strong>
                    )}
                    {message.role === "assistant" ? (
                      renderMessageContent(message.content)
                    ) : (
                      message.content
                    )}
                  </div>
                </div>
              ))}

              {streamingMessage && (
                <div className="message assistant">
                  <div className="message-content">
                    <strong>Assistant: </strong>
                    {renderMessageContent(streamingMessage.content, true)}
                  </div>
                </div>
              )}
            </>
          )}

          {loading && !streamingMessage && (
            <div className="message assistant">
              <div className="message-content">
                <strong>Assistant: </strong>
                <span className="typing-indicator">
                  <span className="typing-dots">
                    <span>.</span>
                    <span>.</span>
                    <span>.</span>
                  </span>
                </span>
              </div>
            </div>
          )}
          <div ref={conversationEndRef} />
        </div>

        {error && <div className="error-message">{error}</div>}

        <form onSubmit={handleSubmit} className="input-form">
          <div className="input-container">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about production data..."
              disabled={loading}
            />
            <button type="submit" disabled={loading || !input.trim()}>
              {loading ? "Processing..." : "Send"}
            </button>
          </div>
        </form>

        {(conversation.length > 0 || streamingMessage) && (
          <button onClick={clearConversation} className="clear-button">
            Clear Conversation
          </button>
        )}
      </div>
    </div>
  );
}

export default App;