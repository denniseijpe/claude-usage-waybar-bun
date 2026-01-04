# claude-usage

A lightweight waybar/polybar module to monitor your Claude Code usage limits.

![Screenshot](screenshot.png)

## Features

- Shows 5-hour and 7-day usage percentages in your status bar
- Hover tooltip with detailed info (reset times, plan, tier)
- Desktop notifications at 50%, 80%, 90%, and 95% thresholds
- Color-coded status (normal, warning, critical)
- Click to open Claude usage dashboard

## Requirements

- Python 3.6+
- `curl`
- `notify-send` (libnotify)
- Claude Code CLI authenticated (`~/.claude/.credentials.json`)
- Waybar or Polybar

## Installation

### Manual

```bash
# Clone the repo
git clone https://github.com/bartvanvliet/claude-usage.git
cd claude-usage

# Copy to your local bin
cp claude-usage ~/.local/bin/
chmod +x ~/.local/bin/claude-usage

# Test it
claude-usage
```

### One-liner

```bash
curl -sL https://raw.githubusercontent.com/bartvanvliet/claude-usage/main/claude-usage -o ~/.local/bin/claude-usage && chmod +x ~/.local/bin/claude-usage
```

## Waybar Configuration

Add to your `~/.config/waybar/config.jsonc`:

```jsonc
{
  "modules-right": [
    "custom/claude-usage",
    // ... other modules
  ],

  "custom/claude-usage": {
    "exec": "~/.local/bin/claude-usage",
    "return-type": "json",
    "interval": 300,
    "on-click": "xdg-open https://claude.ai/settings/usage",
    "on-click-right": "pkill -SIGRTMIN+9 waybar",
    "signal": 9
  }
}
```

Add to your `~/.config/waybar/style.css`:

```css
#custom-claude-usage {
  margin: 0 7.5px;
}

#custom-claude-usage.warning {
  color: #d4a656;
}

#custom-claude-usage.critical {
  color: #a55555;
}

#custom-claude-usage.error {
  color: #a55555;
  opacity: 0.6;
}
```

## Mako Notification Styling (Optional)

Add to your `~/.config/mako/config`:

```ini
[app-name=Claude]
border-color=#d4a656

[app-name=Claude urgency=critical]
border-color=#a55555
background-color=#302030
```

## How It Works

The script reads your Claude Code OAuth credentials from `~/.claude/.credentials.json` (created when you authenticate with `claude`) and calls the Anthropic API to fetch your current usage:

- `GET https://api.anthropic.com/api/oauth/usage` - Usage percentages and reset times
- `GET https://api.anthropic.com/api/oauth/profile` - Account and organization info

Notification state is stored in `~/.cache/claude-usage-state.json` to prevent duplicate alerts.

## Output Format

The script outputs waybar-compatible JSON:

```json
{
  "text": "󰧑 19%",
  "tooltip": "Bart @ Marktmentor\n\n5-hour:   19% used\n         resets in 3h 45m (Sun 17:59)\n\n7-day:     3% used\n         resets in 6d 3h (Sat 17:59)\n\nPlan: Claude Team\nTier: default_claude_max_5x\nExtra: $0.00 (no limit)",
  "class": "normal",
  "percentage": 19
}
```

## Credits

Inspired by [CodexBar](https://github.com/steipete/CodexBar) - a macOS menu bar app for tracking Claude/Codex usage.

## License

MIT
