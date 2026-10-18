import { useApp } from './store.ts';
import { GameScreen } from './ui/GameScreen.tsx';
import { LobbyScreen } from './ui/LobbyScreen.tsx';
import { Toasts } from './ui/Toasts.tsx';

export function App() {
  const inGame = useApp((s) => s.room !== null);
  return (
    <>
      {inGame ? <GameScreen /> : <LobbyScreen />}
      <Toasts />
    </>
  );
}
