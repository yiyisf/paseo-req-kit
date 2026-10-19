// Opening the plugin's screens from anywhere in it (screens themselves are not handed an opener).
type Opener = (input: { screenId: string; params?: Record<string, string> }) => void;

let opener: Opener | null = null;

export function setScreenOpener(open: Opener): void {
  opener = open;
}

export function openReview(input: { repo: string; featureDir: string; title: string }): void {
  opener?.({ screenId: "review", params: { repo: input.repo, featureDir: input.featureDir, title: input.title } });
}
