import React from "react";

import { Link } from "gatsby";

import { Image } from "@/components/Image";

import * as styles from "./Author.module.scss";

type Props = {
  author: {
    name: string;
    bio: string;
    photo: string;
  };
  isIndex?: boolean;
};

const Author = ({ author, isIndex }: Props) => (
  <div className={styles.author}>
    <Link to="/">
      <Image alt={author.name} path={author.photo} className={styles.photo} />
    </Link>

    {isIndex ? (
      <h1 className={styles.title}>
        <Link className={styles.link} to="/">
          {author.name}
        </Link>
      </h1>
    ) : (
      <h2 className={styles.title}>
        <Link className={styles.link} to="/">
          {author.name}
        </Link>
      </h2>
    )}
    <p className={styles.subtitle}>
      Staff Software Engineer @ <a href="https://www.xendit.co/en/">Xendit.</a>{" "}
      <br />
      Turning Curiosity and Teamwork Into Real-World Software Solutions <br />
      Giving learning in public a shot.
    </p>
  </div>
);

export default Author;
