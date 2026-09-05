Output artifacts/live-demo/work/02-install.mov

Require git
Require npm

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 31
Set Width 1920
Set Height 1080
Set Padding 42
Set Framerate 30
Set TypingSpeed 28ms
Set Theme "Catppuccin Mocha"
Set MarginFill "#0B1020"
Set Margin 28
Set BorderRadius 16
Set WindowBar "Colorful"
Set WindowBarSize 42

Hide
Type "cd /tmp/autoqa-vhs-install"
Enter
Show

Type "git clone https://github.com/sudip-mondal-2002/auto-qa.git auto-qa"
Enter
Sleep 3s

Type "cd auto-qa"
Enter
Sleep 600ms

Type "npm install"
Enter
Sleep 3s

Type "npm run qa-agent -- init"
Enter
Sleep 2s

Type "npm run qa-agent -- validate"
Enter
Sleep 2s

Type "npm run qa-agent -- spec list"
Enter
Sleep 4s
