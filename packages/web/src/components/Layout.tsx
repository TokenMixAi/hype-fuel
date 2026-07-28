import {Link, NavLink, Outlet} from "react-router-dom";
import {useAccount, useDisconnect} from "wagmi";

import {GITHUB_URL, PRODUCT_NAME} from "../config";
import {useDocumentMeta} from "../hooks/useDocumentMeta";

function Logo() {
  return (
    <svg className="logo-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M13.4 2 4 13.6h5.7L8.9 22 20 9.9h-6.2L13.4 2Z"
        fill="#8ff3d9"
        stroke="#8ff3d9"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Layout() {
  const {address, isConnected} = useAccount();
  const {disconnect} = useDisconnect();

  useDocumentMeta();

  return (
    <div className="shell">
      <header className="header">
        <div className="container header-inner">
          <Link to="/" className="logo">
            <Logo />
            {PRODUCT_NAME}
          </Link>

          <nav className="nav">
            <NavLink to="/app" className="nav-link">
              Get HYPE
            </NavLink>
            <NavLink to="/docs" className="nav-link">
              Docs
            </NavLink>
            <a
              href={GITHUB_URL}
              className="nav-link hide-sm"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            {isConnected && address ? (
              <button
                type="button"
                className="wallet-chip"
                onClick={() => disconnect()}
                title="Disconnect"
              >
                <span className="dot" />
                {address.slice(0, 6)}…{address.slice(-4)}
              </button>
            ) : null}
          </nav>
        </div>
      </header>

      <Outlet />

      <footer className="footer">
        <div className="container footer-inner">
          <span>
            {PRODUCT_NAME} gives gasless HYPE top-ups on HyperEVM. Not affiliated with
            Hyperliquid.
          </span>
          <div className="footer-links">
            <Link to="/docs">Docs</Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
