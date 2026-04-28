"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Languages,
  MessageCircle,
  Mic,
  Play,
  Plus,
  RefreshCw,
  Save,
  Wand2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";
const VOCAB_PAGE_SIZE = 50;

type LanguageCode = "tagalog" | "hiligaynon" | "japanese" | "spanish";
type LanguageLevel = "beginner" | "elementary" | "intermediate" | "advanced";
type LanguageTab = "practice" | "conversation" | "voice" | "hiragana" | "words" | "phrases" | "review";
type WordPracticeMode = "flashcard" | "target-to-english" | "english-to-target";

type HiraganaCharacter = {
  kana: string;
  romaji: string;
};

type HiraganaRow = {
  label: string;
  sounds: string;
  characters: HiraganaCharacter[];
};

type HiraganaPracticeWord = {
  kana: string;
  romaji: string;
  meaning: string;
};

type HiraganaWeek = {
  week: number;
  title: string;
  rows: HiraganaRow[];
  drill: string;
  words: HiraganaPracticeWord[];
};

type LanguageMetadata = {
  code: LanguageCode;
  name: string;
  local_name: string;
  script_hint: string;
  greeting: string;
  focus_topics: string[];
};

type LanguageProfile = {
  target_languages: LanguageCode[];
  active_language: LanguageCode;
  level: LanguageLevel;
  daily_goal_minutes: number;
  correction_style: "gentle" | "strict" | "immersion";
  romanization: boolean;
  updated_at?: string | null;
};

type LanguagePracticePrompt = {
  id: string;
  mode: "vocabulary" | "conversation" | "writing" | "grammar" | "listening";
  title: string;
  prompt: string;
  target_phrase: string;
  romanization: string;
  translation: string;
  notes: string;
  expected_answer: string;
};

type LanguageVocabItem = {
  id: string;
  language: LanguageCode;
  phrase: string;
  translation: string;
  pronunciation: string;
  notes: string;
  tags: string[];
  review_count: number;
  next_review_at?: string | null;
};

type LanguagePracticeSession = {
  id: string;
  language: LanguageCode;
  mode: "daily" | "conversation" | "vocabulary" | "writing" | "grammar" | "listening";
  minutes: number;
  notes: string;
  created_at?: string | null;
};

type LanguageDashboardResponse = {
  profile: LanguageProfile;
  supported_languages: LanguageMetadata[];
  daily_prompts: LanguagePracticePrompt[];
  daily_focus_words: LanguageVocabItem[];
  vocab: LanguageVocabItem[];
  recent_sessions: LanguagePracticeSession[];
  progress: {
    sessions_count: number;
    minutes_practiced: number;
    vocab_count: number;
    due_reviews: number;
    today_minutes: number;
    language_minutes: number;
    language_sessions_count: number;
  };
  language_progress: Array<{
    language: LanguageCode;
    today_minutes: number;
    total_minutes: number;
    sessions_count: number;
    words_count: number;
    phrases_count: number;
    due_reviews: number;
  }>;
};

type GeneratedPractice = {
  language: LanguageCode;
  level: LanguageLevel;
  title: string;
  overview: string;
  prompts: LanguagePracticePrompt[];
  suggested_minutes: number;
};

type LanguageFeedback = {
  transcript: string;
  target_text: string;
  score: number;
  corrected_text: string;
  feedback: string;
  strengths: string[];
  fixes: string[];
  drills: string[];
};

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  romanization?: string;
  translation?: string;
  correction?: string;
  suggestedReply?: string;
  suggestedReplyRomanization?: string;
  vocab?: LanguageVocabItem[];
};

type LanguageVocabUpdateRequest = {
  phrase: string;
  translation: string;
  pronunciation: string;
  notes: string;
  tags: string[];
};

type ConversationResponse = {
  reply: string;
  reply_romanization: string;
  translation: string;
  correction: string;
  suggested_user_reply: string;
  suggested_user_reply_romanization: string;
  vocab: LanguageVocabItem[];
};

type WordExplanation = {
  word: string;
  translation: string;
  romanization: string;
  part_of_speech: string;
  explanation: string;
  usage_notes: string[];
  examples: Array<{
    target: string;
    romanization: string;
    translation: string;
    note: string;
  }>;
  common_mistakes: string[];
  quick_drill: string;
};

const EMPTY_PROFILE: LanguageProfile = {
  target_languages: ["tagalog", "hiligaynon", "japanese", "spanish"],
  active_language: "tagalog",
  level: "beginner",
  daily_goal_minutes: 15,
  correction_style: "gentle",
  romanization: true,
};

const EMPTY_LANGUAGE_SECONDS: Record<LanguageCode, number> = {
  tagalog: 0,
  hiligaynon: 0,
  japanese: 0,
  spanish: 0,
};

const HIRAGANA_WEEKS: HiraganaWeek[] = [
  {
    week: 1,
    title: "A-row + K-row",
    rows: [
      { label: "A-row", sounds: "a i u e o", characters: [
        { kana: "あ", romaji: "a" },
        { kana: "い", romaji: "i" },
        { kana: "う", romaji: "u" },
        { kana: "え", romaji: "e" },
        { kana: "お", romaji: "o" },
      ] },
      { label: "K-row", sounds: "ka ki ku ke ko", characters: [
        { kana: "か", romaji: "ka" },
        { kana: "き", romaji: "ki" },
        { kana: "く", romaji: "ku" },
        { kana: "け", romaji: "ke" },
        { kana: "こ", romaji: "ko" },
      ] },
    ],
    drill: "Read across each row, then mix the ten cards until the sound is instant.",
    words: [
      { kana: "あお", romaji: "ao", meaning: "blue" },
      { kana: "いえ", romaji: "ie", meaning: "house" },
      { kana: "かお", romaji: "kao", meaning: "face" },
      { kana: "きく", romaji: "kiku", meaning: "to listen" },
      { kana: "ここ", romaji: "koko", meaning: "here" },
      { kana: "いく", romaji: "iku", meaning: "to go" },
    ],
  },
  {
    week: 2,
    title: "S-row + T-row",
    rows: [
      { label: "S-row", sounds: "sa shi su se so", characters: [
        { kana: "さ", romaji: "sa" },
        { kana: "し", romaji: "shi" },
        { kana: "す", romaji: "su" },
        { kana: "せ", romaji: "se" },
        { kana: "そ", romaji: "so" },
      ] },
      { label: "T-row", sounds: "ta chi tsu te to", characters: [
        { kana: "た", romaji: "ta" },
        { kana: "ち", romaji: "chi" },
        { kana: "つ", romaji: "tsu" },
        { kana: "て", romaji: "te" },
        { kana: "と", romaji: "to" },
      ] },
    ],
    drill: "Pay extra attention to shi, chi, and tsu. Say them aloud before typing.",
    words: [
      { kana: "すし", romaji: "sushi", meaning: "sushi" },
      { kana: "そこ", romaji: "soko", meaning: "there" },
      { kana: "した", romaji: "shita", meaning: "under" },
      { kana: "ちかい", romaji: "chikai", meaning: "near" },
      { kana: "たかい", romaji: "takai", meaning: "tall / expensive" },
      { kana: "つくえ", romaji: "tsukue", meaning: "desk" },
    ],
  },
  {
    week: 3,
    title: "N-row + H-row",
    rows: [
      { label: "N-row", sounds: "na ni nu ne no", characters: [
        { kana: "な", romaji: "na" },
        { kana: "に", romaji: "ni" },
        { kana: "ぬ", romaji: "nu" },
        { kana: "ね", romaji: "ne" },
        { kana: "の", romaji: "no" },
      ] },
      { label: "H-row", sounds: "ha hi fu he ho", characters: [
        { kana: "は", romaji: "ha" },
        { kana: "ひ", romaji: "hi" },
        { kana: "ふ", romaji: "fu" },
        { kana: "へ", romaji: "he" },
        { kana: "ほ", romaji: "ho" },
      ] },
    ],
    drill: "Contrast nu, ne, and no visually. Then practice h-row with a soft fu sound.",
    words: [
      { kana: "はな", romaji: "hana", meaning: "flower / nose" },
      { kana: "ひと", romaji: "hito", meaning: "person" },
      { kana: "ねこ", romaji: "neko", meaning: "cat" },
      { kana: "いぬ", romaji: "inu", meaning: "dog" },
      { kana: "ふね", romaji: "fune", meaning: "boat" },
      { kana: "ほし", romaji: "hoshi", meaning: "star" },
    ],
  },
  {
    week: 4,
    title: "M-row + Y-row",
    rows: [
      { label: "M-row", sounds: "ma mi mu me mo", characters: [
        { kana: "ま", romaji: "ma" },
        { kana: "み", romaji: "mi" },
        { kana: "む", romaji: "mu" },
        { kana: "め", romaji: "me" },
        { kana: "も", romaji: "mo" },
      ] },
      { label: "Y-row", sounds: "ya yu yo", characters: [
        { kana: "や", romaji: "ya" },
        { kana: "ゆ", romaji: "yu" },
        { kana: "よ", romaji: "yo" },
      ] },
    ],
    drill: "Mix the three y-row cards with m-row so the shorter row still gets repeated.",
    words: [
      { kana: "やま", romaji: "yama", meaning: "mountain" },
      { kana: "ゆき", romaji: "yuki", meaning: "snow" },
      { kana: "よむ", romaji: "yomu", meaning: "to read" },
      { kana: "みみ", romaji: "mimi", meaning: "ear" },
      { kana: "まめ", romaji: "mame", meaning: "bean" },
      { kana: "むし", romaji: "mushi", meaning: "bug" },
    ],
  },
  {
    week: 5,
    title: "R-row + W/N-row",
    rows: [
      { label: "R-row", sounds: "ra ri ru re ro", characters: [
        { kana: "ら", romaji: "ra" },
        { kana: "り", romaji: "ri" },
        { kana: "る", romaji: "ru" },
        { kana: "れ", romaji: "re" },
        { kana: "ろ", romaji: "ro" },
      ] },
      { label: "W/N-row", sounds: "wa o n", characters: [
        { kana: "わ", romaji: "wa" },
        { kana: "を", romaji: "o" },
        { kana: "ん", romaji: "n" },
      ] },
    ],
    drill: "Treat を as the object-particle o for now, then drill ん at the end of sample syllables.",
    words: [
      { kana: "くるま", romaji: "kuruma", meaning: "car" },
      { kana: "そら", romaji: "sora", meaning: "sky" },
      { kana: "わたし", romaji: "watashi", meaning: "I / me" },
      { kana: "これ", romaji: "kore", meaning: "this" },
      { kana: "いろ", romaji: "iro", meaning: "color" },
      { kana: "ほん", romaji: "hon", meaning: "book" },
    ],
  },
  {
    week: 6,
    title: "Dakuten + Handakuten",
    rows: [
      { label: "Dakuten", sounds: "g z d b rows", characters: [
        { kana: "が", romaji: "ga" },
        { kana: "ざ", romaji: "za" },
        { kana: "だ", romaji: "da" },
        { kana: "ば", romaji: "ba" },
      ] },
      { label: "Handakuten", sounds: "p row", characters: [
        { kana: "ぱ", romaji: "pa" },
        { kana: "ぴ", romaji: "pi" },
        { kana: "ぷ", romaji: "pu" },
        { kana: "ぺ", romaji: "pe" },
        { kana: "ぽ", romaji: "po" },
      ] },
    ],
    drill: "Use this week to learn how marks change sounds, then fold marked kana into the earlier rows.",
    words: [
      { kana: "かぜ", romaji: "kaze", meaning: "wind / cold" },
      { kana: "かぎ", romaji: "kagi", meaning: "key" },
      { kana: "ぶた", romaji: "buta", meaning: "pig" },
      { kana: "てがみ", romaji: "tegami", meaning: "letter" },
      { kana: "ぱん", romaji: "pan", meaning: "bread" },
      { kana: "ぺん", romaji: "pen", meaning: "pen" },
    ],
  },
];

function formatLanguageName(code: LanguageCode, languages: LanguageMetadata[]) {
  return languages.find((language) => language.code === code)?.name ?? code;
}

function formatSessionTime(value: string | null | undefined) {
  if (!value) return "Recently";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function normalizeAnswer(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:'"()[\]{}]/g, "")
    .replace(/\s+/g, " ");
}

function stableHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function seededRandom(seed: number) {
  let value = seed || 1;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function shuffleWithSeed<T>(items: T[], seed: number) {
  const shuffled = [...items];
  const random = seededRandom(seed);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function getWordPracticeKey(item: LanguageVocabItem) {
  return [
    item.language,
    normalizeAnswer(item.phrase),
    normalizeAnswer(item.translation),
  ].join(":");
}

function formatSessionDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function isVisibleVocabTag(tag: string) {
  return (
    tag !== "word" &&
    tag !== "phrase" &&
    tag !== "common-600" &&
    tag !== "common-v2" &&
    tag !== "ai-normalized" &&
    !tag.startsWith("rank-")
  );
}

export default function LanguagePage() {
  const [dashboard, setDashboard] = useState<LanguageDashboardResponse | null>(null);
  const [profile, setProfile] = useState<LanguageProfile>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [vocabSaving, setVocabSaving] = useState(false);
  const [vocabNormalizing, setVocabNormalizing] = useState(false);
  const [sessionSaving, setSessionSaving] = useState(false);
  const [error, setError] = useState("");
  const [phrase, setPhrase] = useState("");
  const [translation, setTranslation] = useState("");
  const [pronunciation, setPronunciation] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [sessionNotes, setSessionNotes] = useState("");
  const [currentSessionSeconds, setCurrentSessionSeconds] = useState(0);
  const profileRef = useRef(profile);
  const activeSecondsRef = useRef<Record<LanguageCode, number>>({ ...EMPTY_LANGUAGE_SECONDS });
  const lastLoggedSecondsRef = useRef<Record<LanguageCode, number>>({ ...EMPTY_LANGUAGE_SECONDS });
  const [practiceFocus, setPracticeFocus] = useState("");
  const [generatedPractice, setGeneratedPractice] = useState<GeneratedPractice | null>(null);
  const [generatingPractice, setGeneratingPractice] = useState(false);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [writingResponse, setWritingResponse] = useState("");
  const [feedback, setFeedback] = useState<LanguageFeedback | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [speechLoadingId, setSpeechLoadingId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [recordedChunks, setRecordedChunks] = useState<Blob[]>([]);
  const [conversationScenario, setConversationScenario] = useState("friendly everyday conversation");
  const [conversationInput, setConversationInput] = useState("");
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<LanguageTab>("practice");
  const [wordPracticeMode, setWordPracticeMode] = useState<WordPracticeMode>("flashcard");
  const [wordPracticeIndex, setWordPracticeIndex] = useState(0);
  const [wordPracticeRevealed, setWordPracticeRevealed] = useState(false);
  const [wordPracticeAnswer, setWordPracticeAnswer] = useState("");
  const [wordPracticeChecked, setWordPracticeChecked] = useState(false);
  const [focusWordIndex, setFocusWordIndex] = useState(0);
  const [focusWordRevealed, setFocusWordRevealed] = useState(false);
  const [wordExplanations, setWordExplanations] = useState<Record<string, WordExplanation>>({});
  const [wordExplanationLoadingId, setWordExplanationLoadingId] = useState<string | null>(null);
  const [exploredWords, setExploredWords] = useState<Record<string, WordExplanation>>({});
  const [exploringHistory, setExploringHistory] = useState<{ language: LanguageCode; word: string }[]>([]);
  const [exploringIndex, setExploringIndex] = useState(-1);
  const [exploredWordLoading, setExploredWordLoading] = useState(false);
  const [explorerSaving, setExplorerSaving] = useState(false);
  const [explorerSavedKeys, setExplorerSavedKeys] = useState<Set<string>>(new Set());
  const [vocabSearch, setVocabSearch] = useState("");
  const [visibleVocabCount, setVisibleVocabCount] = useState(VOCAB_PAGE_SIZE);
  const [profileExpanded, setProfileExpanded] = useState(false);
  const [editingVocabId, setEditingVocabId] = useState<string | null>(null);
  const [editPhrase, setEditPhrase] = useState("");
  const [editTranslation, setEditTranslation] = useState("");
  const [editPronunciation, setEditPronunciation] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [vocabUpdating, setVocabUpdating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [vocabDeleting, setVocabDeleting] = useState<string | null>(null);
  const [savingConvVocab, setSavingConvVocab] = useState<string | null>(null);
  const [shuffledWordPracticeDeck, setShuffledWordPracticeDeck] = useState<LanguageVocabItem[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewRevealed, setReviewRevealed] = useState(false);
  const [reviewShowNotes, setReviewShowNotes] = useState(false);
  const [hiraganaWeekIndex, setHiraganaWeekIndex] = useState(0);
  const [hiraganaPracticeIndex, setHiraganaPracticeIndex] = useState(0);
  const [hiraganaAnswer, setHiraganaAnswer] = useState("");
  const [hiraganaChecked, setHiraganaChecked] = useState(false);
  const [hiraganaRandomized, setHiraganaRandomized] = useState(false);
  const [hiraganaShuffleSeed, setHiraganaShuffleSeed] = useState(1);

  const activeLanguage = useMemo(
    () => dashboard?.supported_languages.find((language) => language.code === profile.active_language) ?? null,
    [dashboard?.supported_languages, profile.active_language]
  );

  const dueVocab = useMemo(() => {
    const now = new Date().toISOString();
    return (dashboard?.vocab || []).filter(
      (item) =>
        item.language === profile.active_language &&
        (!item.next_review_at || item.next_review_at <= now)
    );
  }, [dashboard?.vocab, profile.active_language]);
  const activePrompts = generatedPractice?.prompts.length ? generatedPractice.prompts : dashboard?.daily_prompts || [];
  const selectedPrompt = activePrompts.find((prompt) => prompt.id === selectedPromptId) ?? activePrompts[0] ?? null;
  const dailyFocusWords = useMemo(
    () =>
      (dashboard?.daily_focus_words || []).filter(
        (item) => item.language === profile.active_language
      ),
    [dashboard?.daily_focus_words, profile.active_language]
  );
  const currentFocusWord = dailyFocusWords.length
    ? dailyFocusWords[Math.min(focusWordIndex, dailyFocusWords.length - 1)]
    : null;
  const wordVocab = useMemo(
    () =>
      (dashboard?.vocab || []).filter(
        (item) => item.language === profile.active_language && item.tags.includes("word")
      ),
    [dashboard?.vocab, profile.active_language]
  );
  const phraseVocab = useMemo(
    () =>
      (dashboard?.vocab || []).filter(
        (item) => item.language === profile.active_language && !item.tags.includes("word")
      ),
    [dashboard?.vocab, profile.active_language]
  );
  const wordPracticeDeck = useMemo(() => {
    const seen = new Set<string>();
    const deck: LanguageVocabItem[] = [];
    for (const item of wordVocab) {
      const key = getWordPracticeKey(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deck.push(item);
    }
    return deck;
  }, [wordVocab]);
  const activeVocabKind = activeTab === "words" ? "word" : "phrase";
  const activeVocabItems = activeVocabKind === "word" ? wordVocab : phraseVocab;
  const unenrichedVocabCount = useMemo(
    () =>
      activeVocabItems.filter(
        (item) =>
          !item.tags.includes("ai-normalized") &&
          !item.tags.includes("common-600")
      ).length,
    [activeVocabItems]
  );
  const filteredVocabItems = useMemo(() => {
    const query = vocabSearch.trim().toLowerCase();
    if (!query) return activeVocabItems;
    return activeVocabItems.filter((item) =>
      [
        item.phrase,
        item.translation,
        item.notes,
        item.tags.join(" "),
      ].some((value) => value.toLowerCase().includes(query))
    );
  }, [activeVocabItems, vocabSearch]);
  const visibleVocabItems = filteredVocabItems.slice(0, visibleVocabCount);
  const currentPracticeWord = shuffledWordPracticeDeck.length
    ? shuffledWordPracticeDeck[Math.min(wordPracticeIndex, shuffledWordPracticeDeck.length - 1)]
    : null;
  const expectedWordAnswer = currentPracticeWord
    ? wordPracticeMode === "english-to-target"
      ? currentPracticeWord.phrase
      : currentPracticeWord.translation
    : "";
  const wordAnswerCorrect =
    Boolean(wordPracticeAnswer.trim()) &&
    normalizeAnswer(wordPracticeAnswer) === normalizeAnswer(expectedWordAnswer);
  const currentHiraganaWeek = HIRAGANA_WEEKS[hiraganaWeekIndex] ?? HIRAGANA_WEEKS[0];
  const hiraganaPracticeDeck = useMemo(() => {
    const deck = currentHiraganaWeek.rows.flatMap((row) => row.characters);
    if (!hiraganaRandomized) return deck;
    return shuffleWithSeed(
      deck,
      stableHash(`${currentHiraganaWeek.week}:${hiraganaShuffleSeed}`)
    );
  }, [currentHiraganaWeek, hiraganaRandomized, hiraganaShuffleSeed]);
  const currentHiraganaCard = hiraganaPracticeDeck.length
    ? hiraganaPracticeDeck[Math.min(hiraganaPracticeIndex, hiraganaPracticeDeck.length - 1)]
    : null;
  const hiraganaAnswerCorrect =
    Boolean(hiraganaAnswer.trim()) &&
    (currentHiraganaCard
      ? normalizeAnswer(hiraganaAnswer) === normalizeAnswer(currentHiraganaCard.romaji)
      : false);

  const loadDashboard = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Language dashboard request failed with status ${response.status}`);
      }
      const data: LanguageDashboardResponse = await response.json();
      setDashboard(data);
      setProfile(data.profile);
      setSelectedPromptId((current) => current || data.daily_prompts[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load language practice.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, []);

  const saveProfile = async () => {
    setSavingProfile(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!response.ok) {
        throw new Error(`Profile save failed with status ${response.status}`);
      }
      const saved: LanguageProfile = await response.json();
      setProfile(saved);
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save language profile.");
    } finally {
      setSavingProfile(false);
    }
  };

  const addVocab = async () => {
    if (!phrase.trim()) return;
    setVocabSaving(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/vocab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          phrase,
          translation,
          pronunciation,
          notes,
          tags: Array.from(
            new Set([
              activeVocabKind,
              ...tags.split(",").map((tag) => tag.trim()).filter(Boolean),
            ])
          ),
        }),
      });
      if (!response.ok) {
        throw new Error(`Vocabulary save failed with status ${response.status}`);
      }
      setPhrase("");
      setTranslation("");
      setPronunciation("");
      setNotes("");
      setTags("");
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save vocabulary.");
    } finally {
      setVocabSaving(false);
    }
  };

  const reviewVocab = async (id: string, remembered: boolean) => {
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/vocab/${id}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remembered }),
      });
      if (!response.ok) {
        throw new Error(`Review update failed with status ${response.status}`);
      }
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update review.");
    }
  };

  const advanceWordPractice = () => {
    setWordPracticeIndex((current) => {
      if (!shuffledWordPracticeDeck.length) return 0;
      return (current + 1) % shuffledWordPracticeDeck.length;
    });
    setWordPracticeRevealed(false);
    setWordPracticeAnswer("");
    setWordPracticeChecked(false);
  };

  const advanceFocusWord = () => {
    setFocusWordIndex((current) => {
      if (!dailyFocusWords.length) return 0;
      return (current + 1) % dailyFocusWords.length;
    });
    setFocusWordRevealed(false);
  };

  const markFocusWord = async (remembered: boolean) => {
    if (!currentFocusWord) return;
    await reviewVocab(currentFocusWord.id, remembered);
    advanceFocusWord();
  };

  const markWordPractice = async (remembered: boolean) => {
    if (!currentPracticeWord) return;
    await reviewVocab(currentPracticeWord.id, remembered);
    advanceWordPractice();
  };

  useEffect(() => {
    if (wordPracticeIndex > 0 && wordPracticeIndex >= shuffledWordPracticeDeck.length) {
      setWordPracticeIndex(0);
    }
  }, [wordPracticeIndex, shuffledWordPracticeDeck.length]);

  useEffect(() => {
    setWordPracticeIndex(0);
    setWordPracticeRevealed(false);
    setWordPracticeAnswer("");
    setWordPracticeChecked(false);
    setFocusWordIndex(0);
    setFocusWordRevealed(false);
    setVisibleVocabCount(VOCAB_PAGE_SIZE);
  }, [profile.active_language]);

  useEffect(() => {
    setVisibleVocabCount(VOCAB_PAGE_SIZE);
  }, [activeTab, vocabSearch]);

  useEffect(() => {
    setReviewShowNotes(false);
  }, [reviewIndex]);

  useEffect(() => {
    if (focusWordIndex > 0 && focusWordIndex >= dailyFocusWords.length) {
      setFocusWordIndex(0);
    }
  }, [dailyFocusWords.length, focusWordIndex]);

  useEffect(() => {
    const deck = [...wordPracticeDeck];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    setShuffledWordPracticeDeck(deck);
    setWordPracticeIndex(0);
    setWordPracticeRevealed(false);
    setWordPracticeAnswer("");
    setWordPracticeChecked(false);
  }, [wordPracticeDeck]);

  useEffect(() => {
    setHiraganaPracticeIndex(0);
    setHiraganaAnswer("");
    setHiraganaChecked(false);
  }, [hiraganaWeekIndex, hiraganaRandomized, hiraganaShuffleSeed]);

  const advanceHiraganaPractice = () => {
    setHiraganaPracticeIndex((current) => {
      if (!hiraganaPracticeDeck.length) return 0;
      return (current + 1) % hiraganaPracticeDeck.length;
    });
    setHiraganaAnswer("");
    setHiraganaChecked(false);
  };

  const saveTrackedSession = useCallback(
    async (language: LanguageCode, minutes: number, notes: string) => {
      const response = await fetch(`${API_BASE}/languages/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          mode: "daily",
          minutes,
          notes,
        }),
      });
      if (!response.ok) {
        throw new Error(`Session log failed with status ${response.status}`);
      }
    },
    []
  );

  const autoSaveSession = useCallback((notes = "Auto-tracked", language = profileRef.current.active_language) => {
    const activeSeconds = activeSecondsRef.current[language] || 0;
    const lastLoggedSeconds = lastLoggedSecondsRef.current[language] || 0;
    const unloggedSeconds = activeSeconds - lastLoggedSeconds;
    const minutes = Math.floor(unloggedSeconds / 60);
    if (minutes < 1) return;
    lastLoggedSecondsRef.current[language] = lastLoggedSeconds + minutes * 60;
    void fetch(`${API_BASE}/languages/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language,
        mode: "daily",
        minutes,
        notes,
      }),
    });
  }, []);

  const switchActiveLanguage = async (code: LanguageCode) => {
    const previousLanguage = profile.active_language;
    autoSaveSession("Auto-saved before switching languages", previousLanguage);
    const newProfile = { ...profile, active_language: code };
    profileRef.current = newProfile;
    setProfile(newProfile);
    setCurrentSessionSeconds(activeSecondsRef.current[code] || 0);
    try {
      await fetch(`${API_BASE}/languages/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newProfile),
      });
      await loadDashboard();
    } catch {
      // state already updated; dashboard reload failure is non-fatal
    }
  };

  useEffect(() => {
    profileRef.current = profile;
    setCurrentSessionSeconds(activeSecondsRef.current[profile.active_language] || 0);
  }, [profile]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }
      const language = profileRef.current.active_language;
      activeSecondsRef.current[language] = (activeSecondsRef.current[language] || 0) + 1;
      setCurrentSessionSeconds(activeSecondsRef.current[language]);
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const flushWithBeacon = () => {
      (Object.keys(activeSecondsRef.current) as LanguageCode[]).forEach((language) => {
        const activeSeconds = activeSecondsRef.current[language] || 0;
        const lastLoggedSeconds = lastLoggedSecondsRef.current[language] || 0;
        const minutes = Math.floor((activeSeconds - lastLoggedSeconds) / 60);
        if (minutes < 1) return;
        lastLoggedSecondsRef.current[language] = lastLoggedSeconds + minutes * 60;

        const body = JSON.stringify({
          language,
          mode: "daily",
          minutes,
          notes: sessionNotes || "Auto-tracked on close",
        });
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(`${API_BASE}/languages/sessions`, blob);
      });
    };

    window.addEventListener("beforeunload", flushWithBeacon);
    return () => {
      window.removeEventListener("beforeunload", flushWithBeacon);
    };
  }, [sessionNotes]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      autoSaveSession("Auto-saved while practicing");
    }, 15 * 60 * 1000);

    return () => window.clearInterval(interval);
  }, [autoSaveSession]);

  const endSession = async () => {
    const language = profile.active_language;
    const activeSeconds = activeSecondsRef.current[language] || 0;
    const lastLoggedSeconds = lastLoggedSecondsRef.current[language] || 0;
    const unloggedSeconds = activeSeconds - lastLoggedSeconds;
    const unlogged = unloggedSeconds >= 30 ? Math.max(1, Math.round(unloggedSeconds / 60)) : 0;
    setSessionSaving(true);
    setError("");
    try {
      if (unlogged >= 1) {
        await saveTrackedSession(language, unlogged, sessionNotes || "Auto-tracked");
      }
      activeSecondsRef.current[language] = 0;
      lastLoggedSecondsRef.current[language] = 0;
      setCurrentSessionSeconds(0);
      setSessionNotes("");
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to log practice.");
    } finally {
      setSessionSaving(false);
    }
  };

  const generatePractice = async () => {
    setGeneratingPractice(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/practice/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          level: profile.level,
          mode: "daily",
          focus: practiceFocus,
          include_saved_vocab: true,
        }),
      });
      if (!response.ok) {
        throw new Error(`AI practice generation failed with status ${response.status}`);
      }
      const data: GeneratedPractice = await response.json();
      setGeneratedPractice(data);
      setSelectedPromptId(data.prompts[0]?.id || "");
      setFeedback(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to generate practice.");
    } finally {
      setGeneratingPractice(false);
    }
  };

  const requestWritingFeedback = async () => {
    if (!selectedPrompt || !writingResponse.trim()) return;
    setFeedbackLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/feedback/writing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          level: profile.level,
          prompt: selectedPrompt.prompt,
          response: writingResponse,
          correction_style: profile.correction_style,
        }),
      });
      if (!response.ok) {
        throw new Error(`Writing feedback failed with status ${response.status}`);
      }
      setFeedback(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to get writing feedback.");
    } finally {
      setFeedbackLoading(false);
    }
  };

  const playSpeech = async (prompt: LanguagePracticePrompt, speed: "slow" | "normal" = "normal") => {
    const text = prompt.target_phrase || prompt.expected_answer || prompt.prompt;
    if (!text.trim()) return;
    setSpeechLoadingId(`${prompt.id}-${speed}`);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          text,
          speed,
        }),
      });
      if (!response.ok) {
        throw new Error(`Speech generation failed with status ${response.status}`);
      }
      const blob = await response.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audio.onended = () => URL.revokeObjectURL(audioUrl);
      await audio.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to play language audio.");
    } finally {
      setSpeechLoadingId(null);
    }
  };

  const playLanguageText = async (
    id: string,
    language: LanguageCode,
    text: string,
    speed: "slow" | "normal" = "normal"
  ) => {
    if (!text.trim()) return;
    setSpeechLoadingId(`${id}-${speed}`);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          text,
          speed,
        }),
      });
      if (!response.ok) {
        throw new Error(`Speech generation failed with status ${response.status}`);
      }
      const blob = await response.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audio.onended = () => URL.revokeObjectURL(audioUrl);
      await audio.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to play language audio.");
    } finally {
      setSpeechLoadingId(null);
    }
  };

  const playJapaneseText = async (id: string, text: string, speed: "slow" | "normal" = "normal") => {
    await playLanguageText(id, "japanese", text, speed);
  };

  const submitHiraganaAnswer = () => {
    if (!currentHiraganaCard || !hiraganaAnswer.trim()) return;
    setHiraganaChecked(true);
    window.setTimeout(() => {
      advanceHiraganaPractice();
    }, 700);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not support microphone recording.");
      return;
    }
    setError("");
    setRecordedChunks([]);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
          setRecordedChunks((current) => [...current, event.data]);
        }
      };
      recorder.onstop = () => {
        setRecordedChunks(chunks);
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      setMediaRecorder(recorder);
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to access the microphone.");
    }
  };

  const stopRecording = () => {
    mediaRecorder?.stop();
    setRecording(false);
    setMediaRecorder(null);
  };

  const requestPronunciationFeedback = async () => {
    if (!selectedPrompt || !recordedChunks.length) return;
    setFeedbackLoading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("language", profile.active_language);
      form.append("level", profile.level);
      form.append("target_text", selectedPrompt.target_phrase || selectedPrompt.expected_answer || selectedPrompt.prompt);
      form.append("audio", new Blob(recordedChunks, { type: "audio/webm" }), "practice.webm");
      const response = await fetch(`${API_BASE}/languages/feedback/pronunciation`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        throw new Error(`Pronunciation feedback failed with status ${response.status}`);
      }
      setFeedback(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to get pronunciation feedback.");
    } finally {
      setFeedbackLoading(false);
    }
  };

  const sendConversationMessage = async (messageOverride?: string) => {
    const message = (messageOverride ?? conversationInput).trim();
    if (!message) return;
    const nextMessages: ConversationMessage[] = [...conversationMessages, { role: "user", content: message }];
    setConversationMessages(nextMessages);
    setConversationInput("");
    setConversationLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          level: profile.level,
          correction_style: profile.correction_style,
          scenario: conversationScenario,
          message,
          history: conversationMessages.map(({ role, content }) => ({ role, content })),
        }),
      });
      if (!response.ok) {
        throw new Error(`Conversation response failed with status ${response.status}`);
      }
      const data: ConversationResponse = await response.json();
      setConversationMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: data.reply,
          romanization: data.reply_romanization || undefined,
          translation: data.translation,
          correction: data.correction,
          suggestedReply: data.suggested_user_reply || undefined,
          suggestedReplyRomanization: data.suggested_user_reply_romanization || undefined,
          vocab: data.vocab?.length ? data.vocab : undefined,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to continue the conversation.");
    } finally {
      setConversationLoading(false);
    }
  };

  const explainWord = async (item: LanguageVocabItem) => {
    const cached = wordExplanations[item.id];
    if (cached) {
      return;
    }
    setWordExplanationLoadingId(item.id);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/words/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: item.language,
          level: profile.level,
          word: item.phrase,
          translation: item.translation,
          notes: item.notes,
        }),
      });
      if (!response.ok) {
        throw new Error(`Word explanation failed with status ${response.status}`);
      }
      const data: WordExplanation = await response.json();
      setWordExplanations((current) => ({ ...current, [item.id]: data }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to explain that word.");
    } finally {
      setWordExplanationLoadingId(null);
    }
  };

  const exploreExampleWord = async (word: string, language: LanguageCode) => {
    const trimmed = word.trim();
    if (!trimmed || /^[\s　、。！？、。！？,.!?]+$/.test(trimmed)) return;
    const newIndex = exploringIndex + 1;
    setExploringHistory((prev) => [...prev.slice(0, newIndex), { language, word: trimmed }]);
    setExploringIndex(newIndex);
    const key = `${language}:${trimmed}`;
    if (exploredWords[key]) return;
    setExploredWordLoading(true);
    try {
      const response = await fetch(`${API_BASE}/languages/words/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, level: profile.level, word: trimmed, translation: "", notes: "" }),
      });
      if (!response.ok) throw new Error(`Status ${response.status}`);
      const data: WordExplanation = await response.json();
      setExploredWords((prev) => ({ ...prev, [key]: data }));
    } catch {
      setExploringHistory((prev) => prev.slice(0, newIndex));
      setExploringIndex(newIndex - 1);
    } finally {
      setExploredWordLoading(false);
    }
  };

  const addWordFromExplorer = async (exp: WordExplanation, language: LanguageCode) => {
    const key = `${language}:${exp.word}`;
    setExplorerSaving(true);
    try {
      const response = await fetch(`${API_BASE}/languages/vocab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          phrase: exp.word,
          translation: exp.translation,
          pronunciation: exp.romanization,
          notes: exp.usage_notes.slice(0, 1).join("") || "",
          tags: ["word", exp.part_of_speech].filter(Boolean),
        }),
      });
      if (!response.ok) throw new Error(`Status ${response.status}`);
      setExplorerSavedKeys((prev) => new Set(prev).add(key));
    } catch {
      // silently fail — user can retry
    } finally {
      setExplorerSaving(false);
    }
  };

  const segmentForExplore = (text: string, language: LanguageCode): React.ReactNode => {
    const locale = language === "japanese" ? "ja" : language === "spanish" ? "es" : language === "tagalog" ? "tl" : undefined;
    type Seg = { text: string; isWord: boolean };
    let segments: Seg[];
    try {
      const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
      segments = [...segmenter.segment(text)].map((s) => ({ text: s.segment, isWord: s.isWordLike ?? false }));
    } catch {
      segments = text.split(/(\s+)/).map((s) => ({ text: s, isWord: /\S/.test(s) }));
    }
    return (
      <>
        {segments.map((seg, i) =>
          seg.isWord ? (
            <span
              key={i}
              className="cursor-pointer rounded px-px transition-colors hover:bg-cyan-300/20 hover:text-cyan-200"
              onClick={() => void exploreExampleWord(seg.text, language)}
            >
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </>
    );
  };

  const deleteVocab = async (id: string) => {
    setVocabDeleting(id);
    setConfirmDeleteId(null);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/vocab/${id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        throw new Error(`Delete failed with status ${response.status}`);
      }
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete vocabulary item.");
    } finally {
      setVocabDeleting(null);
    }
  };

  const normalizeExistingWords = async () => {
    setVocabNormalizing(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/vocab/normalize-existing`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Normalize failed with status ${response.status}`);
      }
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to normalize existing words.");
    } finally {
      setVocabNormalizing(false);
    }
  };

  const updateVocab = async (id: string) => {
    if (!editPhrase.trim()) return;
    setVocabUpdating(true);
    setError("");
    try {
      const payload: LanguageVocabUpdateRequest = {
        phrase: editPhrase,
        translation: editTranslation,
        pronunciation: editPronunciation,
        notes: editNotes,
        tags: activeVocabKind === "word" ? ["word"] : [],
      };
      const response = await fetch(`${API_BASE}/languages/vocab/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`Update failed with status ${response.status}`);
      }
      setEditingVocabId(null);
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update vocabulary item.");
    } finally {
      setVocabUpdating(false);
    }
  };

  const saveConversationVocab = async (item: LanguageVocabItem) => {
    setSavingConvVocab(item.phrase);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/vocab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          phrase: item.phrase,
          translation: item.translation,
          notes: item.notes,
          tags: item.tags.length ? item.tags : ["conversation"],
        }),
      });
      if (!response.ok) {
        throw new Error(`Save failed with status ${response.status}`);
      }
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save vocabulary.");
    } finally {
      setSavingConvVocab(null);
    }
  };

  const toggleTargetLanguage = (code: LanguageCode) => {
    setProfile((current) => {
      const enabled = current.target_languages.includes(code);
      const nextTargets = enabled
        ? current.target_languages.filter((language) => language !== code)
        : [...current.target_languages, code];
      const target_languages = nextTargets.length ? nextTargets : [code];
      return {
        ...current,
        target_languages,
        active_language: target_languages.includes(current.active_language)
          ? current.active_language
          : target_languages[0],
      };
    });
  };

  const renderWordExplanation = (item: LanguageVocabItem) => {
    const explanation = wordExplanations[item.id];
    if (!explanation) return null;
    return (
      <div className="mt-4 rounded-[1.1rem] border border-cyan-300/15 bg-cyan-300/8 p-4">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-white">
            {explanation.word || item.phrase}
            {explanation.romanization ? (
              <span className="ml-2 text-cyan-100">{explanation.romanization}</span>
            ) : null}
          </div>
          <div className="text-sm text-slate-300">{explanation.translation || item.translation}</div>
          {explanation.part_of_speech ? (
            <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{explanation.part_of_speech}</div>
          ) : null}
        </div>
        {explanation.explanation ? (
          <p className="mt-3 text-sm leading-6 text-slate-300">{explanation.explanation}</p>
        ) : null}
        {explanation.usage_notes.length ? (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Usage</div>
            <ul className="mt-2 space-y-1 text-sm text-slate-300">
              {explanation.usage_notes.map((note) => (
                <li key={note}>- {note}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {explanation.examples.length ? (
          <div className="mt-4 space-y-3">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Examples</div>
            {explanation.examples.map((example, index) => (
              <div key={`${example.target}-${index}`} className="rounded-xl bg-black/20 p-3 text-sm">
                <div className="font-medium text-white">{segmentForExplore(example.target, item.language)}</div>
                {example.romanization ? (
                  <div className="mt-1 text-cyan-100">{segmentForExplore(example.romanization, item.language)}</div>
                ) : null}
                <div className="mt-1 text-slate-300">{example.translation}</div>
                {example.note ? <div className="mt-1 text-xs text-slate-500">{example.note}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
        {explanation.common_mistakes.length ? (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Watch for</div>
            <ul className="mt-2 space-y-1 text-sm text-slate-300">
              {explanation.common_mistakes.map((mistake) => (
                <li key={mistake}>- {mistake}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {explanation.quick_drill ? (
          <div className="mt-4 rounded-xl border border-white/8 bg-white/5 p-3 text-sm text-cyan-100">
            {explanation.quick_drill}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-[rgb(17,19,34)] px-4 py-6 text-slate-100 md:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 rounded-[1.5rem] border border-white/8 bg-[rgba(35,37,58,0.72)] p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-cyan-100">
              Language Practice
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Jarvis Language Lab</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              Practice Tagalog, Hiligaynon, Japanese, and Spanish with daily prompts, saved phrases, review timing, and lightweight session tracking.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dashboard?.supported_languages.length ? (
              <select
                className="h-9 rounded-2xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 text-sm text-white"
                value={profile.active_language}
                onChange={(event) => void switchActiveLanguage(event.target.value as LanguageCode)}
              >
                {dashboard.supported_languages
                  .filter((l) => profile.target_languages.includes(l.code))
                  .map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.name}
                    </option>
                  ))}
              </select>
            ) : null}
            <Button asChild variant="outline" className="rounded-2xl">
              <Link href="/">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Dashboard
              </Link>
            </Button>
            <Button variant="outline" className="rounded-2xl" onClick={() => void loadDashboard()} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
            {error}
          </div>
        ) : null}

        {dashboard ? (
          <div className="rounded-[1.2rem] border border-white/8 bg-[rgba(24,27,44,0.86)] p-4">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Practice overview</div>
                <div className="mt-1 text-sm text-slate-300">Progress across all target languages</div>
              </div>
              <div className="text-xs text-slate-500">Daily goal: {profile.daily_goal_minutes} min per language</div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {dashboard.language_progress.map((item) => {
                const language = dashboard.supported_languages.find((entry) => entry.code === item.language);
                const pct = Math.min(100, profile.daily_goal_minutes > 0 ? Math.round((item.today_minutes / profile.daily_goal_minutes) * 100) : 0);
                const active = item.language === profile.active_language;
                const done = item.today_minutes >= profile.daily_goal_minutes;
                return (
                  <button
                    key={item.language}
                    type="button"
                    className={`rounded-[1.1rem] border p-4 text-left transition-colors ${
                      active
                        ? "border-cyan-300/30 bg-cyan-300/10"
                        : "border-white/8 bg-white/5 hover:border-white/15"
                    }`}
                    onClick={() => void switchActiveLanguage(item.language)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-white">{language?.name ?? item.language}</div>
                        <div className="mt-1 text-xs text-slate-500">{language?.greeting}</div>
                      </div>
                      {active ? <Badge>Active</Badge> : null}
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-3">
                      <div>
                        <div className={`text-2xl font-semibold ${done ? "text-emerald-300" : "text-white"}`}>
                          {item.today_minutes}
                        </div>
                        <div className="text-xs uppercase tracking-[0.14em] text-slate-500">min today</div>
                      </div>
                      <div className="text-right text-xs leading-5 text-slate-400">
                        <div>{item.total_minutes} total min</div>
                        <div>{item.sessions_count} sessions</div>
                      </div>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                      <div
                        className={`h-full rounded-full transition-all ${done ? "bg-emerald-400" : "bg-cyan-400"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs text-slate-400">
                      <div className="rounded-lg bg-black/20 px-2 py-1">{item.words_count} words</div>
                      <div className="rounded-lg bg-black/20 px-2 py-1">{item.phrases_count} phrases</div>
                      <div className="rounded-lg bg-black/20 px-2 py-1">{item.due_reviews} due</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="space-y-3 rounded-[1.2rem] border border-white/8 bg-[rgba(24,27,44,0.86)] p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">
                Active session · {formatLanguageName(profile.active_language, dashboard?.supported_languages || [])}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Time is tracked separately for each language while this tab is active.
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              {formatSessionDuration(currentSessionSeconds)}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Input
              value={sessionNotes}
              onChange={(event) => setSessionNotes(event.target.value)}
              placeholder="Add a note for this session (optional)"
            />
            <Button className="rounded-2xl" onClick={() => void endSession()} disabled={sessionSaving || currentSessionSeconds < 30}>
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {sessionSaving ? "Saving..." : "End session"}
            </Button>
          </div>
        </div>

        <div className="sticky top-0 z-20 flex gap-1 rounded-[1.2rem] border border-white/8 bg-[rgba(24,27,44,0.95)] p-2 backdrop-blur-sm">
          {[
            ["practice", "Practice", MessageCircle],
            ["conversation", "Conversation", MessageCircle],
            ["voice", "Voice", Mic],
            ["hiragana", "Hiragana", BookOpen],
            ["words", "Words", BookOpen],
            ["phrases", "Phrases", Languages],
            ["review", "Review", CheckCircle2],
          ].map(([key, label, Icon]) => {
            const tabKey = key as LanguageTab;
            const TabIcon = Icon as typeof MessageCircle;
            return (
              <Button
                key={tabKey}
                variant={activeTab === tabKey ? "default" : "ghost"}
                className="flex-1 rounded-xl"
                onClick={() => setActiveTab(tabKey)}
              >
                <TabIcon className="h-4 w-4 shrink-0 sm:mr-2" />
                <span className="hidden sm:inline">{label as string}</span>
              </Button>
            );
          })}
        </div>

        {activeTab === "practice" ? (
        <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Languages className="h-5 w-5" />
                  Profile
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1 rounded-xl"
                  onClick={() => setProfileExpanded((c) => !c)}
                >
                  {profileExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  {profileExpanded ? "Hide" : "Edit"}
                </Button>
              </div>
              {!profileExpanded ? (
                <div className="mt-1 text-sm text-slate-400">
                  {formatLanguageName(profile.active_language, dashboard?.supported_languages || [])} · {profile.level} · {profile.daily_goal_minutes} min/day
                </div>
              ) : null}
            </CardHeader>
            {profileExpanded ? (
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Active language</label>
                <select
                  className="h-11 rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 text-sm text-white"
                  value={profile.active_language}
                  onChange={(event) =>
                    setProfile((current) => ({ ...current, active_language: event.target.value as LanguageCode }))
                  }
                >
                  {(dashboard?.supported_languages || []).map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Target languages</label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(dashboard?.supported_languages || []).map((language) => (
                    <label key={language.code} className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/5 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={profile.target_languages.includes(language.code)}
                        onChange={() => toggleTargetLanguage(language.code)}
                      />
                      {language.name}
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Level</label>
                  <select
                    className="h-11 rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 text-sm text-white"
                    value={profile.level}
                    onChange={(event) =>
                      setProfile((current) => ({ ...current, level: event.target.value as LanguageLevel }))
                    }
                  >
                    <option value="beginner">Beginner</option>
                    <option value="elementary">Elementary</option>
                    <option value="intermediate">Intermediate</option>
                    <option value="advanced">Advanced</option>
                  </select>
                </div>
                <div className="grid gap-2">
                  <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Daily minutes</label>
                  <Input
                    type="number"
                    min={1}
                    max={240}
                    value={profile.daily_goal_minutes}
                    onChange={(event) =>
                      setProfile((current) => ({ ...current, daily_goal_minutes: Number(event.target.value) || 15 }))
                    }
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Corrections</label>
                  <select
                    className="h-11 rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 text-sm text-white"
                    value={profile.correction_style}
                    onChange={(event) =>
                      setProfile((current) => ({
                        ...current,
                        correction_style: event.target.value as LanguageProfile["correction_style"],
                      }))
                    }
                  >
                    <option value="gentle">Gentle</option>
                    <option value="strict">Strict</option>
                    <option value="immersion">Immersion</option>
                  </select>
                </div>
                <label className="mt-6 flex items-center gap-2 rounded-xl border border-white/8 bg-white/5 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={profile.romanization}
                    onChange={(event) =>
                      setProfile((current) => ({ ...current, romanization: event.target.checked }))
                    }
                  />
                  Romanization support
                </label>
              </div>

              <Button className="w-full rounded-2xl" onClick={() => void saveProfile()} disabled={savingProfile}>
                <Save className="mr-2 h-4 w-4" />
                {savingProfile ? "Saving..." : "Save profile"}
              </Button>
            </CardContent>
            ) : null}
          </Card>

          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5" />
                Daily Practice
              </CardTitle>
              {activeLanguage ? (
                <div className="text-sm text-slate-300">
                  {activeLanguage.name} · {activeLanguage.greeting} · {activeLanguage.script_hint}
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-[1.2rem] border border-cyan-300/15 bg-cyan-300/8 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-cyan-100">
                      Today&apos;s focus words
                    </div>
                    <div className="mt-1 text-sm text-slate-300">
                      {dailyFocusWords.length
                        ? `${dailyFocusWords.length} words selected for ${activeLanguage?.name || "this language"} today.`
                        : "No focus words yet. Add or seed words to start."}
                    </div>
                  </div>
                  <Button variant="outline" className="rounded-2xl" onClick={() => setActiveTab("words")}>
                    Open Words
                  </Button>
                </div>

                {currentFocusWord ? (
                  <div
                    className="mt-4 cursor-pointer rounded-[1.1rem] border border-white/8 bg-black/20 p-4 transition-colors hover:border-cyan-300/20"
                    onClick={() => setFocusWordRevealed((current) => !current)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFocusWordRevealed((current) => !current); } }}
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="text-xs uppercase tracking-[0.16em] text-slate-500">
                          {focusWordIndex + 1} of {dailyFocusWords.length}
                        </div>
                        <div className="mt-3 text-3xl font-semibold text-white">{currentFocusWord.phrase}</div>
                        {currentFocusWord.pronunciation ? (
                          <div className="mt-2 text-sm text-slate-400">{currentFocusWord.pronunciation}</div>
                        ) : null}
                        <div className="mt-4 min-h-10 text-lg text-slate-200">
                          {focusWordRevealed ? currentFocusWord.translation : "Say or type the meaning, then reveal it."}
                        </div>
                        {focusWordRevealed && currentFocusWord.notes ? (
                          <div className="mt-2 text-sm text-cyan-100">{currentFocusWord.notes}</div>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2 md:justify-end">
                        <Button
                          variant="outline"
                          className="rounded-2xl"
                          onClick={(e) => { e.stopPropagation(); void playLanguageText(`focus-word-${currentFocusWord.id}`, currentFocusWord.language, currentFocusWord.phrase, "slow"); }}
                          disabled={Boolean(speechLoadingId)}
                        >
                          <Play className="mr-2 h-4 w-4" />
                          {speechLoadingId === `focus-word-${currentFocusWord.id}-slow` ? "Loading..." : "Play"}
                        </Button>
                        <Button variant="outline" className="rounded-2xl" onClick={(e) => { e.stopPropagation(); setFocusWordRevealed((current) => !current); }}>
                          {focusWordRevealed ? "Hide" : "Reveal"}
                        </Button>
                      <Button variant="outline" className="rounded-2xl" onClick={(e) => { e.stopPropagation(); advanceFocusWord(); }}>
                        Skip
                      </Button>
                      <Button
                        variant="outline"
                        className="rounded-2xl"
                        onClick={(e) => { e.stopPropagation(); void explainWord(currentFocusWord); }}
                        disabled={wordExplanationLoadingId === currentFocusWord.id}
                      >
                        {wordExplanationLoadingId === currentFocusWord.id ? "Loading..." : "Examples"}
                      </Button>
                    </div>
                  </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button variant="outline" className="rounded-2xl" onClick={(e) => { e.stopPropagation(); void markFocusWord(false); }}>
                        Again
                      </Button>
                      <Button className="rounded-2xl" onClick={(e) => { e.stopPropagation(); void markFocusWord(true); }}>
                      Know it
                    </Button>
                  </div>
                  {renderWordExplanation(currentFocusWord)}
                </div>
              ) : null}
              </div>

              <div className="grid gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 p-4 md:grid-cols-[1fr_auto]">
                <Input
                  value={practiceFocus}
                  onChange={(event) => setPracticeFocus(event.target.value)}
                  placeholder="Optional focus: family, travel, gym, church, work..."
                />
                <Button className="rounded-2xl" onClick={() => void generatePractice()} disabled={generatingPractice}>
                  <Wand2 className="mr-2 h-4 w-4" />
                  {generatingPractice ? "Generating..." : "Generate"}
                </Button>
                {generatedPractice ? (
                  <div className="md:col-span-2 text-sm text-slate-300">
                    <span className="font-medium text-white">{generatedPractice.title}</span> · {generatedPractice.overview}
                  </div>
                ) : null}
              </div>

              {activePrompts.map((prompt) => (
                <div
                  key={prompt.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedPromptId(prompt.id)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedPromptId(prompt.id); }}
                  className={`cursor-pointer rounded-[1.2rem] border p-4 transition-colors ${
                    selectedPromptId === prompt.id
                      ? "border-cyan-300/30 bg-cyan-300/8"
                      : "border-white/8 bg-white/5 hover:border-white/15"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={selectedPromptId === prompt.id ? "default" : "outline"}>{prompt.mode}</Badge>
                      <span className="font-medium text-white">{prompt.title}</span>
                    </div>
                    <div className="flex gap-2" onClick={(event) => event.stopPropagation()}>
                      <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void playSpeech(prompt, "slow")} disabled={Boolean(speechLoadingId)}>
                        <Play className="mr-2 h-3 w-3" />
                        {speechLoadingId === `${prompt.id}-slow` ? "Loading..." : "Slow"}
                      </Button>
                      <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void playSpeech(prompt, "normal")} disabled={Boolean(speechLoadingId)}>
                        <Play className="mr-2 h-3 w-3" />
                        Natural
                      </Button>
                    </div>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-300">{prompt.prompt}</p>
                  <div className="mt-3 rounded-xl bg-black/20 p-3 text-sm">
                    <div className="font-medium text-cyan-100">{prompt.target_phrase}</div>
                    {prompt.romanization ? <div className="mt-1 text-cyan-50">{prompt.romanization}</div> : null}
                    <div className="mt-1 text-slate-400">{prompt.translation}</div>
                    <div className="mt-2 text-xs text-slate-500">{prompt.notes}</div>
                    {prompt.expected_answer ? <div className="mt-2 text-xs text-slate-400">Model answer: {prompt.expected_answer}</div> : null}
                  </div>
                </div>
              ))}

            </CardContent>
          </Card>
        </div>
        ) : null}

        {activeTab === "hiragana" ? (
        <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                Hiragana Rows
              </CardTitle>
              <div className="text-sm text-slate-300">
                Learn the gojuon grid by row pairs, then fold each new row into review.
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {profile.active_language !== "japanese" ? (
                <div className="rounded-[1.2rem] border border-amber-300/20 bg-amber-300/10 p-4">
                  <div className="text-sm font-medium text-white">Switch to Japanese for this track</div>
                  <div className="mt-1 text-sm text-slate-300">
                    Hiragana study belongs with your Japanese practice history and session timer.
                  </div>
                  <Button className="mt-3 rounded-2xl" onClick={() => void switchActiveLanguage("japanese")}>
                    Use Japanese
                  </Button>
                </div>
              ) : null}

              <div className="grid gap-2">
                {HIRAGANA_WEEKS.map((week, index) => (
                  <button
                    key={week.week}
                    type="button"
                    className={`rounded-[1.1rem] border p-3 text-left transition-colors ${
                      hiraganaWeekIndex === index
                        ? "border-cyan-300/30 bg-cyan-300/10"
                        : "border-white/8 bg-white/5 hover:border-white/15"
                    }`}
                    onClick={() => setHiraganaWeekIndex(index)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs uppercase tracking-[0.16em] text-slate-500">Week {week.week}</div>
                        <div className="mt-1 font-medium text-white">{week.title}</div>
                      </div>
                      <Badge variant={hiraganaWeekIndex === index ? "default" : "outline"}>
                        {week.rows.reduce((total, row) => total + row.characters.length, 0)} kana
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
              <CardHeader>
                <CardTitle>Week {currentHiraganaWeek.week}: {currentHiraganaWeek.title}</CardTitle>
                <div className="text-sm text-slate-300">{currentHiraganaWeek.drill}</div>
              </CardHeader>
              <CardContent className="space-y-4">
                {currentHiraganaWeek.rows.map((row) => (
                  <div key={row.label} className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white">{row.label}</div>
                        <div className="text-xs text-slate-400">{row.sounds}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                      {row.characters.map((character) => (
                        <button
                          key={`${row.label}-${character.kana}`}
                          type="button"
                          className="aspect-square rounded-xl border border-white/8 bg-black/20 p-2 text-center transition-colors hover:border-cyan-300/30 hover:bg-cyan-300/10"
                          onClick={() => void playJapaneseText(`hiragana-${character.kana}`, character.kana, "slow")}
                          disabled={Boolean(speechLoadingId)}
                        >
                          <div className="flex h-full flex-col items-center justify-center">
                            <div className="text-4xl font-semibold text-white">{character.kana}</div>
                            <div className="mt-2 text-sm text-cyan-100">{character.romaji}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BookOpen className="h-5 w-5" />
                  Practice Words
                </CardTitle>
                <div className="text-sm text-slate-300">
                  Words here use only kana from week {currentHiraganaWeek.week} or earlier.
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid gap-2 sm:grid-cols-2">
                  {currentHiraganaWeek.words.map((word) => (
                    <button
                      key={word.kana}
                      type="button"
                      className="rounded-[1.1rem] border border-white/8 bg-white/5 p-4 text-left transition-colors hover:border-cyan-300/30 hover:bg-cyan-300/10"
                      onClick={() => void playJapaneseText(`hiragana-word-${word.kana}`, word.kana, "slow")}
                      disabled={Boolean(speechLoadingId)}
                    >
                      <div className="text-3xl font-semibold text-white">{word.kana}</div>
                      <div className="mt-2 text-sm text-cyan-100">{word.romaji}</div>
                      <div className="mt-1 text-sm text-slate-400">{word.meaning}</div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5" />
                      Row Drill
                    </CardTitle>
                    <div className="mt-1 text-sm text-slate-300">
                      {hiraganaPracticeDeck.length ? `${hiraganaPracticeIndex + 1} of ${hiraganaPracticeDeck.length}` : "No kana selected"}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant={hiraganaRandomized ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => {
                        setHiraganaRandomized((current) => !current);
                        setHiraganaShuffleSeed((current) => current + 1);
                      }}
                    >
                      Randomize
                    </Button>
                    {hiraganaRandomized ? (
                      <Button
                        variant="outline"
                        className="rounded-2xl"
                        onClick={() => setHiraganaShuffleSeed((current) => current + 1)}
                      >
                        Reshuffle
                      </Button>
                    ) : null}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {currentHiraganaCard ? (
                  <>
                    <div className="rounded-[1.2rem] border border-cyan-300/15 bg-cyan-300/8 p-6 text-center">
                      <div className="text-7xl font-semibold text-white">{currentHiraganaCard.kana}</div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                      <Input
                        value={hiraganaAnswer}
                        onChange={(event) => {
                          setHiraganaAnswer(event.target.value);
                          setHiraganaChecked(false);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            submitHiraganaAnswer();
                          }
                        }}
                        placeholder="Type romaji"
                      />
                      <Button variant="outline" className="rounded-2xl" onClick={submitHiraganaAnswer}>
                        Check
                      </Button>
                      <Button className="rounded-2xl" onClick={advanceHiraganaPractice}>
                        Next
                      </Button>
                    </div>
                    {hiraganaChecked ? (
                      <div className={`rounded-xl border p-3 text-sm ${
                        hiraganaAnswerCorrect
                          ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
                          : "border-amber-300/25 bg-amber-300/10 text-amber-100"
                      }`}>
                        {hiraganaAnswerCorrect
                          ? "Correct."
                          : `Answer: ${currentHiraganaCard.romaji}`}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
        ) : null}

        {activeTab === "voice" ? (
        <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mic className="h-5 w-5" />
              Voice and Correction
            </CardTitle>
            <div className="text-sm text-slate-300">
              Listen to the current prompt, record yourself, or write an answer and get AI feedback.
            </div>
          </CardHeader>
          <CardContent className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-4">
              <div className="grid gap-2">
                <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Practice target</label>
                <select
                  className="h-11 rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 text-sm text-white"
                  value={selectedPrompt?.id || ""}
                  onChange={(event) => {
                    setSelectedPromptId(event.target.value);
                    setFeedback(null);
                  }}
                >
                  {activePrompts.map((prompt) => (
                    <option key={prompt.id} value={prompt.id}>
                      {prompt.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                <div className="text-sm font-medium text-white">{selectedPrompt?.target_phrase || selectedPrompt?.title || "Choose a prompt"}</div>
                {selectedPrompt?.romanization ? <div className="mt-1 text-sm text-cyan-100">{selectedPrompt.romanization}</div> : null}
                {selectedPrompt?.translation ? <div className="mt-1 text-sm text-slate-400">{selectedPrompt.translation}</div> : null}
                <div className="mt-2 text-sm leading-6 text-slate-300">{selectedPrompt?.prompt}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" className="rounded-2xl" onClick={() => selectedPrompt && void playSpeech(selectedPrompt, "slow")} disabled={!selectedPrompt || Boolean(speechLoadingId)}>
                  <Play className="mr-2 h-4 w-4" />
                  Slow
                </Button>
                <Button variant="outline" className="rounded-2xl" onClick={() => selectedPrompt && void playSpeech(selectedPrompt, "normal")} disabled={!selectedPrompt || Boolean(speechLoadingId)}>
                  <Play className="mr-2 h-4 w-4" />
                  Natural
                </Button>
                <Button className="rounded-2xl" onClick={() => recording ? stopRecording() : void startRecording()} disabled={!selectedPrompt}>
                  {recording ? (
                    <>
                      <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
                      Stop
                    </>
                  ) : (
                    <>
                      <Mic className="mr-2 h-4 w-4" />
                      Record
                    </>
                  )}
                </Button>
                <Button variant="outline" className="rounded-2xl" onClick={() => void requestPronunciationFeedback()} disabled={!recordedChunks.length || feedbackLoading}>
                  {feedbackLoading ? "Checking..." : "Check"}
                </Button>
              </div>
              <div className="space-y-3">
                <textarea
                  className="min-h-28 w-full rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] p-3 text-sm text-white outline-none placeholder:text-slate-500"
                  value={writingResponse}
                  onChange={(event) => setWritingResponse(event.target.value)}
                  placeholder="Write your answer here for grammar and naturalness feedback."
                />
                <Button className="rounded-2xl" onClick={() => void requestWritingFeedback()} disabled={!writingResponse.trim() || feedbackLoading}>
                  {feedbackLoading ? "Checking..." : "Check writing"}
                </Button>
              </div>
            </div>

            <div className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
              {feedback ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-white">AI feedback</div>
                    <Badge>{feedback.score}/100</Badge>
                  </div>
                  {feedback.transcript ? (
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Transcript</div>
                      <div className="mt-1 text-sm text-slate-200">{feedback.transcript}</div>
                    </div>
                  ) : null}
                  {feedback.corrected_text ? (
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Correction</div>
                      <div className="mt-1 text-sm text-cyan-100">{feedback.corrected_text}</div>
                    </div>
                  ) : null}
                  <p className="text-sm leading-6 text-slate-300">{feedback.feedback}</p>
                  {[
                    ["Strengths", feedback.strengths],
                    ["Fixes", feedback.fixes],
                    ["Drills", feedback.drills],
                  ].map(([label, items]) => (
                    Array.isArray(items) && items.length ? (
                      <div key={label as string}>
                        <div className="text-xs uppercase tracking-[0.16em] text-slate-400">{label as string}</div>
                        <ul className="mt-2 space-y-2 text-sm text-slate-300">
                          {items.map((item) => (
                            <li key={item}>- {item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null
                  ))}
                </div>
              ) : (
                <div className="grid min-h-64 place-items-center text-center text-sm text-slate-400">
                  Feedback will appear here after you check pronunciation or writing.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        ) : null}

        {activeTab === "conversation" ? (
        <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5" />
              Conversation Tutor
            </CardTitle>
            <div className="text-sm text-slate-300">
              Practice back-and-forth. Jarvis replies in the target language, translates, and gives compact corrections.
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <Input
                value={conversationScenario}
                onChange={(event) => setConversationScenario(event.target.value)}
                placeholder="Scenario"
              />
              <Button variant="outline" className="rounded-2xl" onClick={() => setConversationMessages([])}>
                Clear chat
              </Button>
            </div>
            <div className="max-h-[50vh] min-h-48 space-y-3 overflow-auto rounded-[1.2rem] border border-white/8 bg-black/20 p-4">
              {conversationMessages.length ? (
                conversationMessages.map((message, index) => (
                  <div
                    key={`${message.role}-${index}`}
                    className={`rounded-[1.1rem] border border-white/8 p-3 ${
                      message.role === "user" ? "ml-auto max-w-[85%] bg-cyan-400/10" : "mr-auto max-w-[85%] bg-white/5"
                    }`}
                  >
                    <div className="text-xs uppercase tracking-[0.14em] text-slate-500">
                      {message.role === "user" ? "You" : "Jarvis"}
                    </div>
                    <div className="mt-1 text-sm leading-6 text-white">{message.content}</div>
                    {message.romanization ? <div className="mt-2 text-sm text-cyan-100">{message.romanization}</div> : null}
                    {message.translation ? <div className="mt-2 text-sm text-slate-400">{message.translation}</div> : null}
                    {message.correction ? <div className="mt-2 text-sm text-cyan-100">{message.correction}</div> : null}
                    {message.role === "assistant" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-3 rounded-xl"
                          onClick={() =>
                            void playSpeech(
                              {
                                id: `conversation-${index}`,
                                mode: "conversation",
                                title: "Conversation reply",
                                prompt: message.content,
                                target_phrase: message.content,
                                romanization: message.romanization || "",
                                translation: message.translation || "",
                                notes: "",
                                expected_answer: "",
                              },
                              "normal"
                            )
                          }
                        >
                          <Play className="mr-2 h-3 w-3" />
                          Play reply
                        </Button>
                        {message.vocab?.length ? (
                          <div className="mt-3 space-y-1.5">
                            <div className="text-xs uppercase tracking-[0.14em] text-slate-500">New words</div>
                            {message.vocab.map((word) => (
                              <div key={word.phrase} className="flex items-center justify-between gap-2 rounded-xl bg-white/5 px-3 py-2 text-sm">
                                <div className="min-w-0">
                                  <span className="font-medium text-white">{word.phrase}</span>
                                  {word.translation ? <span className="ml-2 text-slate-400">{word.translation}</span> : null}
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="shrink-0 rounded-xl"
                                  disabled={savingConvVocab === word.phrase}
                                  onClick={() => void saveConversationVocab(word)}
                                >
                                  {savingConvVocab === word.phrase ? "Saving…" : "Save"}
                                </Button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {message.suggestedReply ? (
                          <button
                            type="button"
                            className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-sm text-slate-300 hover:bg-white/8"
                            onClick={() => setConversationInput(message.suggestedReply!)}
                          >
                            <span className="mr-2 text-xs text-slate-500">Try:</span>
                            {message.suggestedReply}
                            {message.suggestedReplyRomanization ? (
                              <span className="mt-1 block text-cyan-100">{message.suggestedReplyRomanization}</span>
                            ) : null}
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="py-10 text-center text-sm text-slate-400">
                  Start with something simple, like “Hello, how are you?” in your active language.
                </div>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <textarea
                className="min-h-[2.75rem] max-h-36 w-full resize-none rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-500"
                value={conversationInput}
                onChange={(event) => setConversationInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendConversationMessage();
                  }
                }}
                placeholder="Type your message — Shift+Enter for new line"
                rows={2}
              />
              <Button className="self-end rounded-2xl" onClick={() => void sendConversationMessage()} disabled={conversationLoading || !conversationInput.trim()}>
                {conversationLoading ? "Thinking..." : "Send"}
              </Button>
            </div>
          </CardContent>
        </Card>
        ) : null}

        {activeTab === "words" || activeTab === "phrases" ? (
        <div className="grid gap-6">
          {activeTab === "words" ? (
          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5" />
                Word Practice
              </CardTitle>
              <div className="text-sm text-slate-300">
                Practice saved words as flashcards or blind translation checks.
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 md:grid-cols-3">
                {[
                  ["flashcard", "Flashcards"],
                  ["target-to-english", "Word to English"],
                  ["english-to-target", "English to Word"],
                ].map(([mode, label]) => (
                  <Button
                    key={mode}
                    variant={wordPracticeMode === mode ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => {
                      setWordPracticeMode(mode as WordPracticeMode);
                      setWordPracticeRevealed(false);
                      setWordPracticeAnswer("");
                      setWordPracticeChecked(false);
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              {currentPracticeWord ? (
                <div
                  className={`rounded-[1.4rem] border border-white/8 bg-black/20 p-5 ${
                    wordPracticeMode === "flashcard" ? "cursor-pointer transition-colors hover:border-cyan-300/25 hover:bg-cyan-300/5" : ""
                  }`}
                  role={wordPracticeMode === "flashcard" ? "button" : undefined}
                  tabIndex={wordPracticeMode === "flashcard" ? 0 : undefined}
                  onClick={() => {
                    if (wordPracticeMode === "flashcard") {
                      setWordPracticeRevealed((current) => !current);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (wordPracticeMode === "flashcard" && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      setWordPracticeRevealed((current) => !current);
                    }
                  }}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-500">
                        {formatLanguageName(currentPracticeWord.language, dashboard?.supported_languages || [])} · {wordPracticeIndex + 1} of {shuffledWordPracticeDeck.length}
                      </div>
                      <button
                        type="button"
                        className="mt-4 text-left text-3xl font-semibold text-white transition-colors hover:text-cyan-100"
                        onClick={(event) => {
                          event.stopPropagation();
                          void playLanguageText(
                            `practice-word-${currentPracticeWord.id}`,
                            currentPracticeWord.language,
                            currentPracticeWord.phrase,
                            "slow"
                          );
                        }}
                        disabled={Boolean(speechLoadingId)}
                      >
                        {wordPracticeMode === "english-to-target"
                          ? currentPracticeWord.translation || "No translation saved"
                          : currentPracticeWord.phrase}
                      </button>
                      {wordPracticeMode === "flashcard" ? (
                        <div className="mt-4 min-h-12 text-lg text-cyan-100">
                          {wordPracticeRevealed ? currentPracticeWord.translation || "No translation saved" : "Think of the answer, then reveal it."}
                        </div>
                      ) : (
                        <div className="mt-4 space-y-3">
                          <Input
                            value={wordPracticeAnswer}
                            onChange={(event) => {
                              setWordPracticeAnswer(event.target.value);
                              setWordPracticeChecked(false);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                setWordPracticeChecked(true);
                              }
                            }}
                            placeholder={wordPracticeMode === "english-to-target" ? "Type the word" : "Type the English translation"}
                          />
                          {wordPracticeChecked ? (
                            <div className={`rounded-xl border px-3 py-2 text-sm ${
                              wordAnswerCorrect
                                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                                : "border-amber-400/30 bg-amber-500/10 text-amber-100"
                            }`}>
                              {wordAnswerCorrect ? "Correct." : `Answer: ${expectedWordAnswer || "No answer saved"}`}
                            </div>
                          ) : null}
                        </div>
                      )}
                      {currentPracticeWord.pronunciation ? (
                        <div className="mt-2 text-sm text-slate-400">{currentPracticeWord.pronunciation}</div>
                      ) : null}
                      {(wordPracticeRevealed || wordPracticeChecked) && currentPracticeWord.notes ? (
                        <div className="mt-2 text-sm text-slate-400">{currentPracticeWord.notes}</div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2 md:justify-end">
                      <Button
                        variant="outline"
                        className="rounded-2xl"
                        onClick={(event) => {
                          event.stopPropagation();
                          void playLanguageText(
                            `practice-word-${currentPracticeWord.id}`,
                            currentPracticeWord.language,
                            currentPracticeWord.phrase,
                            "slow"
                          );
                        }}
                        disabled={Boolean(speechLoadingId)}
                      >
                        <Play className="mr-2 h-4 w-4" />
                        Play
                      </Button>
                      {wordPracticeMode !== "flashcard" ? (
                        <Button variant="outline" className="rounded-2xl" onClick={() => setWordPracticeChecked(true)}>
                          Check
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        className="rounded-2xl"
                        onClick={(event) => {
                          event.stopPropagation();
                          advanceWordPractice();
                        }}
                      >
                        Skip
                      </Button>
                      <Button
                        variant="outline"
                        className="rounded-2xl"
                        onClick={(event) => {
                          event.stopPropagation();
                          void explainWord(currentPracticeWord);
                        }}
                        disabled={wordExplanationLoadingId === currentPracticeWord.id}
                      >
                        {wordExplanationLoadingId === currentPracticeWord.id ? "Loading..." : "Examples"}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="rounded-2xl"
                      onClick={(event) => {
                        event.stopPropagation();
                        void markWordPractice(false);
                      }}
                    >
                      Again
                    </Button>
                    <Button
                      className="rounded-2xl"
                      onClick={(event) => {
                        event.stopPropagation();
                        void markWordPractice(true);
                      }}
                    >
                      Know it
                    </Button>
                  </div>
                  {renderWordExplanation(currentPracticeWord)}
                </div>
              ) : (
                <div className="rounded-[1.2rem] border border-dashed border-white/12 p-5 text-sm text-slate-400">
                  Add a few words below, then use this space for flashcards and blind translation.
                </div>
              )}
              {wordVocab.length > shuffledWordPracticeDeck.length ? (
                <div className="text-xs text-slate-500">
                  Practice deck uses {shuffledWordPracticeDeck.length} unique words from {wordVocab.length} saved word entries.
                </div>
              ) : null}
            </CardContent>
          </Card>
          ) : null}

          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                {activeVocabKind === "word" ? "Words" : "Phrases"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                <Input
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  placeholder={activeVocabKind === "word" ? "Word" : "Phrase"}
                />
                <Input value={translation} onChange={(event) => setTranslation(event.target.value)} placeholder="Translation" />
                <Input value={pronunciation} onChange={(event) => setPronunciation(event.target.value)} placeholder="Pronunciation (e.g. romaji)" />
                <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Tags, comma separated" />
                <Input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" />
                <Button className="rounded-2xl" onClick={() => void addVocab()} disabled={vocabSaving || !phrase.trim()}>
                  <Plus className="mr-2 h-4 w-4" />
                  {vocabSaving ? "Normalizing..." : activeVocabKind === "word" ? "Save word" : "Save phrase"}
                </Button>
                {unenrichedVocabCount > 0 ? (
                  <Button
                    variant="outline"
                    className="rounded-2xl"
                    onClick={() => void normalizeExistingWords()}
                    disabled={vocabNormalizing}
                  >
                    <Wand2 className="mr-2 h-4 w-4" />
                    {vocabNormalizing ? "Normalizing..." : `Normalize ${unenrichedVocabCount} existing`}
                  </Button>
                ) : null}
              </div>

              <div className="flex flex-col gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 p-4 md:flex-row md:items-center md:justify-between">
                <Input
                  value={vocabSearch}
                  onChange={(event) => setVocabSearch(event.target.value)}
                  placeholder={`Search ${activeVocabKind === "word" ? "words" : "phrases"}`}
                  className="md:max-w-md"
                />
                <div className="text-sm text-slate-400">
                  Showing {Math.min(visibleVocabItems.length, filteredVocabItems.length)} of {filteredVocabItems.length}
                  {filteredVocabItems.length !== activeVocabItems.length ? ` filtered from ${activeVocabItems.length}` : ""}
                </div>
              </div>

              <div className="space-y-3">
                {visibleVocabItems.map((item) => (
                  <div key={item.id} className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                    {editingVocabId === item.id ? (
                      <div className="space-y-3">
                        <Input value={editPhrase} onChange={(e) => setEditPhrase(e.target.value)} placeholder="Word / phrase" />
                        <Input value={editTranslation} onChange={(e) => setEditTranslation(e.target.value)} placeholder="Translation" />
                        <Input value={editPronunciation} onChange={(e) => setEditPronunciation(e.target.value)} placeholder="Pronunciation (e.g. romaji)" />
                        <Input value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="Notes" />
                        <div className="flex gap-2">
                          <Button size="sm" className="rounded-xl" onClick={() => void updateVocab(item.id)} disabled={vocabUpdating || !editPhrase.trim()}>
                            {vocabUpdating ? "Saving…" : "Save"}
                          </Button>
                          <Button size="sm" variant="outline" className="rounded-xl" onClick={() => setEditingVocabId(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <div className="text-sm text-slate-400">{formatLanguageName(item.language, dashboard?.supported_languages || [])}</div>
                            <button
                              type="button"
                              className="mt-1 text-left font-medium text-white transition-colors hover:text-cyan-100"
                              onClick={() => void playLanguageText(`vocab-${item.id}`, item.language, item.phrase, "slow")}
                              disabled={Boolean(speechLoadingId)}
                            >
                              {item.phrase}
                            </button>
                            <div className="mt-1 text-sm text-slate-300">{item.translation}</div>
                            {item.pronunciation ? <div className="mt-1 text-sm text-slate-400">{item.pronunciation}</div> : null}
                            {item.notes ? <div className="mt-1 text-sm text-cyan-100">{item.notes}</div> : null}
                            {item.tags.filter(isVisibleVocabTag).length ? (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {item.tags.filter(isVisibleVocabTag).map((tag) => (
                                  <Badge key={tag} variant="outline">{tag}</Badge>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-xl"
                              onClick={() => void playLanguageText(`vocab-${item.id}`, item.language, item.phrase, "slow")}
                              disabled={Boolean(speechLoadingId)}
                            >
                              <Play className="mr-2 h-3 w-3" />
                              Play
                            </Button>
                            <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void reviewVocab(item.id, false)}>
                              Again
                            </Button>
                            <Button size="sm" className="rounded-xl" onClick={() => void reviewVocab(item.id, true)}>
                              Know it
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-xl"
                              onClick={() => void explainWord(item)}
                              disabled={wordExplanationLoadingId === item.id}
                            >
                              {wordExplanationLoadingId === item.id ? "Loading..." : "Examples"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-xl"
                              onClick={() => {
                                setEditingVocabId(item.id);
                                setEditPhrase(item.phrase);
                                setEditTranslation(item.translation);
                                setEditPronunciation(item.pronunciation);
                                setEditNotes(item.notes);
                                setConfirmDeleteId(null);
                              }}
                            >
                              Edit
                            </Button>
                            {confirmDeleteId === item.id ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="rounded-xl border-rose-400/40 text-rose-300 hover:bg-rose-500/10"
                                disabled={vocabDeleting === item.id}
                                onClick={() => void deleteVocab(item.id)}
                              >
                                {vocabDeleting === item.id ? "Deleting…" : "Confirm?"}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="rounded-xl text-slate-400"
                                onClick={() => setConfirmDeleteId(item.id)}
                              >
                                Delete
                              </Button>
                            )}
                          </div>
                        </div>
                        {renderWordExplanation(item)}
                      </>
                    )}
                  </div>
                ))}
                {visibleVocabCount < filteredVocabItems.length ? (
                  <Button
                    variant="outline"
                    className="w-full rounded-2xl"
                    onClick={() => setVisibleVocabCount((current) => current + VOCAB_PAGE_SIZE)}
                  >
                    Show more
                  </Button>
                ) : null}
                {!activeVocabItems.length && !loading ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/12 p-5 text-sm text-slate-400">
                    Save {activeVocabKind === "word" ? "individual words" : "phrases"} from practice here; Jarvis will keep a review queue.
                  </div>
                ) : null}
                {activeVocabItems.length > 0 && filteredVocabItems.length === 0 ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/12 p-5 text-sm text-slate-400">
                    No {activeVocabKind === "word" ? "words" : "phrases"} match that search.
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
        ) : null}

        {activeTab === "review" ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5" />
                Review Queue
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {dueVocab.length > 0 ? (() => {
                const currentDue = dueVocab[Math.min(reviewIndex, dueVocab.length - 1)];
                const doneAll = reviewIndex >= dueVocab.length;
                return (
                  <div
                    className={`rounded-[1.2rem] border border-cyan-300/15 bg-cyan-300/8 p-4 ${!doneAll ? "cursor-pointer transition-colors hover:border-cyan-300/25" : ""}`}
                    onClick={!doneAll ? () => setReviewRevealed((c) => !c) : undefined}
                    role={!doneAll ? "button" : undefined}
                    tabIndex={!doneAll ? 0 : undefined}
                    onKeyDown={!doneAll ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setReviewRevealed((c) => !c); } } : undefined}
                  >
                    {doneAll ? (
                      <div className="py-4 text-center">
                        <div className="text-lg font-semibold text-white">All caught up!</div>
                        <div className="mt-1 text-sm text-slate-400">No more items due right now.</div>
                        <Button variant="outline" className="mt-4 rounded-2xl" onClick={() => setReviewIndex(0)}>
                          Review again
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <div className="text-xs uppercase tracking-[0.16em] text-cyan-100">Due now</div>
                          <div className="text-xs text-slate-500">{reviewIndex + 1} of {dueVocab.length}</div>
                        </div>
                        <button
                          type="button"
                          className="mt-4 text-left text-3xl font-semibold text-white transition-colors hover:text-cyan-100"
                          onClick={() => void playLanguageText(`review-${currentDue.id}`, currentDue.language, currentDue.phrase, "slow")}
                          disabled={Boolean(speechLoadingId)}
                        >
                          {currentDue.phrase}
                        </button>
                        <div className="mt-4 min-h-8 text-lg text-slate-200">
                          {reviewRevealed ? currentDue.translation || "No translation saved" : "Think of the answer, then reveal."}
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            className="rounded-2xl"
                            onClick={(e) => { e.stopPropagation(); void playLanguageText(`review-${currentDue.id}`, currentDue.language, currentDue.phrase, "slow"); }}
                            disabled={Boolean(speechLoadingId)}
                          >
                            <Play className="mr-2 h-4 w-4" />
                            Play
                          </Button>
                          <Button variant="outline" className="rounded-2xl" onClick={(e) => { e.stopPropagation(); setReviewRevealed((c) => !c); }}>
                            {reviewRevealed ? "Hide" : "Reveal"}
                          </Button>
                        </div>
                        {currentDue.pronunciation ? (
                          <div className="mt-2 text-sm text-slate-400">{currentDue.pronunciation}</div>
                        ) : null}
                        {reviewRevealed ? (
                          <>
                            {reviewShowNotes && currentDue.notes ? (
                              <div className="mt-2 text-sm text-cyan-100">{currentDue.notes}</div>
                            ) : null}
                            <div className="mt-4 flex flex-wrap gap-2">
                              {currentDue.notes ? (
                                <Button
                                  variant="outline"
                                  className="rounded-2xl"
                                  onClick={(e) => { e.stopPropagation(); setReviewShowNotes((c) => !c); }}
                                >
                                  {reviewShowNotes ? "Hide notes" : "Notes"}
                                </Button>
                              ) : null}
                              <Button
                                variant="outline"
                                className="rounded-2xl"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await reviewVocab(currentDue.id, false);
                                  setReviewIndex((i) => i + 1);
                                  setReviewRevealed(false);
                                  setReviewShowNotes(false);
                                }}
                              >
                                Again
                              </Button>
                              <Button
                                className="rounded-2xl"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await reviewVocab(currentDue.id, true);
                                  setReviewIndex((i) => i + 1);
                                  setReviewRevealed(false);
                                  setReviewShowNotes(false);
                                }}
                              >
                                Know it
                              </Button>
                            </div>
                          </>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })() : (
                <div className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                  <div className="text-sm font-medium text-white">No items due</div>
                  <div className="mt-1 text-sm text-slate-400">All words are scheduled for the future. Check back later or add new words to review.</div>
                </div>
              )}
              <div className="space-y-3">
                <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Recent sessions</div>
                {(dashboard?.recent_sessions || []).map((session) => (
                  <div key={session.id} className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-white">
                          {formatLanguageName(session.language, dashboard?.supported_languages || [])} · {session.mode}
                        </div>
                        <div className="mt-1 text-sm text-slate-400">{formatSessionTime(session.created_at)}</div>
                        {session.notes ? <div className="mt-2 text-sm text-slate-300">{session.notes}</div> : null}
                      </div>
                      <Badge>{session.minutes} min</Badge>
                    </div>
                  </div>
                ))}
                {!dashboard?.recent_sessions.length && !loading ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/12 p-5 text-sm text-slate-400">
                    Log your first practice session after finishing today&apos;s prompts.
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
        ) : null}
      </div>

      {exploringIndex >= 0 ? (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/50 backdrop-blur-sm"
          onClick={() => { setExploringHistory([]); setExploringIndex(-1); }}
        >
          <div
            className="max-h-[72vh] w-full overflow-y-auto rounded-t-2xl border-t border-white/10 bg-slate-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  className="text-sm text-slate-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                  disabled={exploringIndex === 0}
                  onClick={() => setExploringIndex((i) => i - 1)}
                >
                  ←
                </button>
                <button
                  className="text-sm text-slate-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                  disabled={exploringIndex >= exploringHistory.length - 1}
                  onClick={() => setExploringIndex((i) => i + 1)}
                >
                  →
                </button>
                <div className="ml-1 text-xs uppercase tracking-[0.16em] text-slate-400">Word explorer</div>
              </div>
              <button
                className="text-lg leading-none text-slate-500 hover:text-white"
                onClick={() => { setExploringHistory([]); setExploringIndex(-1); }}
              >
                ✕
              </button>
            </div>
            {exploredWordLoading && (
              <div className="text-sm text-slate-400">Loading…</div>
            )}
            {!exploredWordLoading && (() => {
              const exploringWord = exploringHistory[exploringIndex];
              if (!exploringWord) return null;
              const key = `${exploringWord.language}:${exploringWord.word}`;
              const exp = exploredWords[key];
              if (!exp) return null;
              const wordLower = exp.word.toLowerCase();
              const alreadySaved =
                explorerSavedKeys.has(key) ||
                (dashboard?.vocab ?? []).some(
                  (v) =>
                    v.language === exploringWord.language &&
                    (v.phrase.toLowerCase() === wordLower ||
                      v.pronunciation.toLowerCase() === wordLower)
                );
              return (
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <button
                          className="text-slate-400 transition-colors hover:text-white disabled:opacity-30"
                          disabled={Boolean(speechLoadingId)}
                          onClick={() => void playLanguageText(`explorer-${exploringWord.language}-${exp.word}`, exploringWord.language, exp.word, "slow")}
                        >
                          <Play className="h-4 w-4" />
                        </button>
                        <div>
                          <div className="text-sm font-medium text-white">
                            {exp.word}
                            {exp.romanization ? <span className="ml-2 text-cyan-100">{exp.romanization}</span> : null}
                          </div>
                          <div className="text-sm text-slate-300">{exp.translation}</div>
                          {exp.part_of_speech ? (
                            <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{exp.part_of_speech}</div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {alreadySaved ? (
                        <div className="rounded-xl border border-cyan-300/30 px-3 py-1 text-xs text-cyan-300">Saved</div>
                      ) : (
                      <Button
                        size="sm"
                        className="rounded-xl"
                        disabled={explorerSaving}
                        onClick={() => void addWordFromExplorer(exp, exploringWord.language)}
                      >
                        {explorerSaving ? "Saving…" : "+ Add to vocab"}
                      </Button>
                    )}
                    </div>
                  </div>
                  {exp.explanation ? (
                    <p className="mt-3 text-sm leading-6 text-slate-300">{exp.explanation}</p>
                  ) : null}
                  {exp.usage_notes.length ? (
                    <div className="mt-4">
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Usage</div>
                      <ul className="mt-2 space-y-1 text-sm text-slate-300">
                        {exp.usage_notes.map((note) => (
                          <li key={note}>- {note}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {exp.examples.length ? (
                    <div className="mt-4 space-y-3">
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Examples</div>
                      {exp.examples.map((ex, i) => (
                        <div key={i} className="rounded-xl bg-black/20 p-3 text-sm">
                          <div className="font-medium text-white">
                            {segmentForExplore(ex.target, exploringWord.language)}
                          </div>
                          {ex.romanization ? (
                            <div className="mt-1 text-cyan-100">
                              {segmentForExplore(ex.romanization, exploringWord.language)}
                            </div>
                          ) : null}
                          <div className="mt-1 text-slate-300">{ex.translation}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {exp.common_mistakes.length ? (
                    <div className="mt-4">
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Watch for</div>
                      <ul className="mt-2 space-y-1 text-sm text-slate-300">
                        {exp.common_mistakes.map((m) => (
                          <li key={m}>- {m}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {exp.quick_drill ? (
                    <div className="mt-4 rounded-xl border border-white/8 bg-white/5 p-3 text-sm text-cyan-100">
                      {exp.quick_drill}
                    </div>
                  ) : null}
                </div>
              );
            })()}
          </div>
        </div>
      ) : null}
    </main>
  );
}
