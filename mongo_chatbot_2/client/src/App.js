import React, { useState } from "react";
import axios from "axios";
import "./App.css";

function App() {
  const [input, setInput] = useState("");
  const [conversation, setConversation] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

      // Add AI response to conversation
      const aiMessage = { role: "assistant", content: response.data.response };
      setConversation((prev) => [...prev, aiMessage]);
    } catch (err) {
      console.error("Error querying agent:", err);
      setError("Failed to get response from AI agent. Please try again.");

      // Add error message to conversation
      const errorMessage = {
        role: "assistant",
        content:
          "Sorry, I encountered an error processing your request. Please try again.",
      };
      setConversation((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
      setInput("");
    }
  };

  const clearConversation = () => {
    setConversation([]);
    setError("");
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
          {conversation.length === 0 ? (
            <div className="empty-state">
              <p>Welcome to the Production Data Assistant!</p>
              <p>Try asking questions like:</p>
              <ul>
                <li>"Show me production reports from yesterday"</li>
                <li>"What batches had defects this week?"</li>
                <li>"Give me the production data for 24th feb?"</li>
                <li>"Show me the production report for the shift A"</li>
              </ul>
            </div>
          ) : (
            conversation.map((message, index) => (
              <div key={index} className={`message ${message.role}`}>
                <div className="message-content">
                  {message.role === "user" ? (
                    <strong>You: </strong>
                  ) : (
                    <strong>Assistant: </strong>
                  )}
                  {message.content}
                </div>
              </div>
            ))
          )}

          {loading && (
            <div className="message assistant">
              <div className="message-content">
                <strong>Assistant: </strong>
                <span className="typing-indicator">Thinking...</span>
              </div>
            </div>
          )}
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

        {conversation.length > 0 && (
          <button onClick={clearConversation} className="clear-button">
            Clear Conversation
          </button>
        )}
      </div>
    </div>
  );
}

export default App;
