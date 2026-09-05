Output artifacts/live-demo/work/03-create-terminal.mov

Require npm

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 29
Set Width 1920
Set Height 1080
Set Padding 42
Set Framerate 30
Set TypingSpeed 24ms
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

Type "npm run qa-agent -- create 'a logged-in customer completes checkout' --id live-checkout --env local --fixture-before login-customer --expect 'Order confirmation is visible'"
Enter
Sleep 3s

Type "npm run qa-agent -- spec show live-checkout"
Enter
Sleep 5s

Type "npm run qa-agent -- validate"
Enter
Sleep 4s
