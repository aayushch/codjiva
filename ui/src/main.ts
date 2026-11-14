import { mount } from 'svelte';
import '$resources/theme/tokens.css';
import './styles/fonts.css';
import './styles/app-shell.css';
import './styles/app-extra.css';
import './styles/theme.css';
import { applyStoredTheme } from '$lib/theme';
import App from './App.svelte';

applyStoredTheme();

mount(App, { target: document.getElementById('root')! });
