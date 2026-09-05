Output artifacts/live-demo/work/08-correctness.mov

Require npm

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 30
Set Width 1920
Set Height 1080
Set Padding 42
Set Framerate 30
Set TypingSpeed 26ms
Set Theme "Catppuccin Mocha"
Set MarginFill "#0B1020"
Set Margin 28
Set BorderRadius 16
Set WindowBar "Colorful"
Set WindowBarSize 42

Hide
Type "cd /tmp/autoqa-vhs-install/auto-qa"
Enter
Show

Type "npm run test:coverage | tail -n 24"
Enter
Sleep 8s

Type "git status --short"
Enter
Sleep 4s
