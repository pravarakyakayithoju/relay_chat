import type { PublicUser } from '@relay/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, clearToken, getToken, setUnauthorizedHandler } from './api';
import { AuthScreen } from './components/AuthScreen';
import { Chat } from './components/Chat';

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [booting, setBooting] = useState(true);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) {
      setBooting(false);
      return;
    }
    // A token is stored from a previous visit: check that it is still valid.
    api
      .me()
      .then(setUser)
      .catch(() => clearToken())
      .finally(() => setBooting(false));
  }, [logout]);

  if (booting) return <div className="center muted">Loading…</div>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  // `key` gives a different user a completely fresh Chat (and socket).
  return <Chat key={user.id} user={user} onLogout={logout} />;
}
