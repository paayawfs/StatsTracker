import { render } from 'preact';
import { App } from './app';
import '@fontsource-variable/figtree';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/barlow-condensed/latin-800.css';
import './index.css';

render(<App />, document.getElementById('app')!);
