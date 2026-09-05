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
Type "cd /tmp/qa-shop-demo-video"
Enter
Type "rm -rf /tmp/qa-shop-demo-video/.qa"
Enter
Type "/Users/sudipmondal/mando/auto-qa/.agents/skills/autonomous-qa/scripts/qa-agent setup --type web --base-url http://127.0.0.1:3000 --start-command 'npm run dev' --root /tmp/qa-shop-demo-video"
Enter
Type "/Users/sudipmondal/mando/auto-qa/.agents/skills/autonomous-qa/scripts/qa-agent fixture save /Users/sudipmondal/mando/auto-qa/.qa/fixtures/login-customer.yaml --root /tmp/qa-shop-demo-video"
Enter
Type "/Users/sudipmondal/mando/auto-qa/.agents/skills/autonomous-qa/scripts/qa-agent fixture save /Users/sudipmondal/mando/auto-qa/.qa/fixtures/cleanup-test-order.yaml --root /tmp/qa-shop-demo-video"
Enter
Type "/Users/sudipmondal/mando/auto-qa/.agents/skills/autonomous-qa/scripts/qa-agent spec save /Users/sudipmondal/mando/auto-qa/.qa/specs/checkout-card.yaml --root /tmp/qa-shop-demo-video"
Enter
Show

Type "find .qa -maxdepth 3 -type f -print | sort"
Enter
Sleep 3s

Type "sed -n '1,80p' .qa/specs/checkout-card.yaml"
Enter
Sleep 5s
