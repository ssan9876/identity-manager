import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthRoot } from './auth/AuthRoot'
import { BRAND } from './brand'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

/**
 * The browser tab follows the brand module too. index.html's own <title>
 * is a static placeholder (it cannot import a module — it is parsed before
 * any bundle exists), so this line is what makes renaming the product a
 * single edit in src/brand/index.tsx for every surface that is not raw
 * HTML. Set before render so it is already correct on the first frame.
 */
document.title = BRAND.name

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthRoot>
        <App />
      </AuthRoot>
    </BrowserRouter>
  </React.StrictMode>,
)
