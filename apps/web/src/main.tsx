import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthRoot } from './auth/AuthRoot'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthRoot>
        <App />
      </AuthRoot>
    </BrowserRouter>
  </React.StrictMode>,
)
